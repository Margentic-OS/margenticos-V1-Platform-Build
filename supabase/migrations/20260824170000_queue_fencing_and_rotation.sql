-- Migration: fence complete_job and fail_job to the lease holder, add the rotation cursor
-- Date: 2026-08-24
--
-- Status: APPLIED (verified live 2026-08-24)
--
-- ═════════════════════════════════════════════════════════════════════════════
-- 1. THE FENCING BUG (money-adjacent)
--
-- complete_job and fail_job both identified a job by id and state alone:
--
--     WHERE id = p_job_id AND state = 'claimed'
--
-- Nothing checked WHO held the claim. So this interleaving corrupts state:
--
--   1. Worker A claims job J. Lease runs to T+120.
--   2. Worker A stalls (slow Apollo call, GC pause, the Vercel 300s wall).
--   3. The lease expires. reclaim_expired_jobs requeues J.
--   4. Worker B claims J and starts working. attempts is now 2.
--   5. Worker A finally comes back and calls complete_job(J).
--   6. The row still has state='claimed', so A's UPDATE MATCHES. J is marked done
--      while B is actively running it.
--
-- The damage is not only a wrong row. B is still going to make its paid API call, and
-- when it finishes, its own complete_job finds state='done' and silently no-ops, so the
-- run that actually did the work leaves no record. Worse in the other direction: A can
-- call fail_job and push a job B is midway through back to 'queued', where a third
-- worker claims it and pays for the same prospect a third time.
--
-- THE FIX: both functions now require the caller to name itself, and the UPDATE only
-- matches when claimed_by still equals that name. A worker whose lease was taken away
-- matches nothing, changes nothing, and gets zero rows back so it can log the fact.
--
-- WHY THE OLD SIGNATURES ARE DROPPED RATHER THAN LEFT IN PLACE. Adding a parameter with
-- CREATE OR REPLACE creates an OVERLOAD in Postgres, not a replacement: complete_job
-- (uuid, text) would remain callable and remain unfenced. Leaving an unfenced version
-- of a function whose whole purpose is fencing would be pointless. Both old signatures
-- are dropped. Their only callers are in src/lib/queue, updated in the same commit, and
-- no queue job has ever been run in production (all three system_flags are false).

DROP FUNCTION IF EXISTS public.complete_job(uuid, text);
DROP FUNCTION IF EXISTS public.fail_job(uuid, text, text, boolean);

-- ─────────────────────────────────────────────────────────────────────────────
-- complete_job, fenced

CREATE OR REPLACE FUNCTION public.complete_job(
  p_job_id  uuid,
  p_worker  text,
  p_summary text
)
RETURNS SETOF public.job_queue
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.job_queue
     SET state            = 'done',
         result_summary   = p_summary,
         lease_expires_at = NULL,
         updated_at       = now()
   WHERE id         = p_job_id
     AND state      = 'claimed'
     -- THE FENCE. A worker whose lease was reclaimed no longer matches, so it cannot
     -- mark done a job that now belongs to someone else.
     AND claimed_by = p_worker
  RETURNING *;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- fail_job, fenced
--
-- The retry policy itself is unchanged: permanent terminates immediately whatever the
-- attempt count, transient backs off unless the cap is reached, and p_force_terminal
-- covers a reclaimed job that already has spend recorded and must never be retried.

CREATE OR REPLACE FUNCTION public.fail_job(
  p_job_id          uuid,
  p_worker          text,
  p_error           text,
  p_error_class     text,
  p_force_terminal  boolean DEFAULT false
)
RETURNS SETOF public.job_queue
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.job_queue q
     SET state = CASE
                   WHEN p_force_terminal             THEN 'failed'
                   WHEN p_error_class = 'permanent'  THEN 'failed'
                   WHEN q.attempts >= q.max_attempts THEN 'failed'
                   ELSE 'queued'
                 END,
         last_error       = p_error,
         last_error_class = p_error_class,
         run_after        = now() + public.job_queue_backoff(q.attempts),
         lease_expires_at = NULL,
         updated_at       = now()
   WHERE q.id         = p_job_id
     AND q.state      = 'claimed'
     -- THE FENCE. Without this, a stalled worker could push a job another worker is
     -- actively running back to 'queued', where a third worker claims it and pays for
     -- the same prospect again.
     AND q.claimed_by = p_worker
  RETURNING q.*;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. THE ROTATION CURSOR
--
-- Ordering organisations by their oldest queued job is not a round-robin. It is a
-- priority queue that returns the same answer every time.
--
-- Worked example on research, whose ceiling cannot be raised because Apify allows only
-- 25 concurrent actor runs and the LinkedIn source uses two per prospect: maxInFlight
-- is 10 rows and the slice is 5, so exactly two organisations fit per pass. With orgs
-- A, B and C all holding deep backlogs, A and B are served and C is not. Next tick, A
-- and B are STILL the two oldest, because their remaining jobs were created at the same
-- moment as the ones just claimed. C never runs, for as long as A and B have work.
--
-- So the planner needs memory of where it stopped. This table is that memory.
--
-- WHY ITS OWN TABLE:
--   not system_flags  that table is booleans for rollout, and a uuid is not a flag
--   not job_queue     that is per-job state; the cursor outlives every individual job
--   not worker memory each Vercel invocation is a fresh process, so an in-memory
--                     cursor resets on every tick and rotates nothing at all
--
-- One row per job type. The worker reads it before planning and writes it after.

CREATE TABLE IF NOT EXISTS queue_rotation (
  job_type             text        PRIMARY KEY,

  -- The LAST organisation served on the previous pass. The next pass begins at the one
  -- after it. Nullable because a fresh row has served nobody yet.
  --
  -- ON DELETE SET NULL, deliberately not CASCADE: deleting the row would delete the
  -- whole job type's cursor and silently reset its rotation. Losing the organisation
  -- reference just means the next pass starts from the oldest, which is the correct
  -- degradation and is exactly what the planner does with an unrecognised cursor.
  last_organisation_id uuid        REFERENCES organisations(id) ON DELETE SET NULL,

  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT queue_rotation_job_type_valid
    CHECK (job_type IN ('enrich', 'research', 'compose'))
);

INSERT INTO queue_rotation (job_type) VALUES ('enrich'), ('research'), ('compose')
ON CONFLICT (job_type) DO NOTHING;

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. ACCESS
--
-- Same shape as job_queue: RLS on, zero policies, service_role only.

ALTER TABLE queue_rotation ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.queue_rotation FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.queue_rotation TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- FUNCTION GRANTS
--
-- The recreated functions are NEW functions as far as Postgres is concerned, so they
-- have been granted EXECUTE to anon and authenticated by Supabase's ALTER DEFAULT
-- PRIVILEGES all over again. Revoking FROM PUBLIC would be a silent no-op, exactly as
-- it was on 2026-08-24 the first time. The roles must be named. See CLAUDE.md,
-- "REVOKE FROM PUBLIC is NOT enough on Supabase".

REVOKE ALL     ON FUNCTION public.complete_job(uuid, text, text)                     FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.complete_job(uuid, text, text)                     FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.complete_job(uuid, text, text)                     TO service_role;

REVOKE ALL     ON FUNCTION public.fail_job(uuid, text, text, text, boolean)          FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fail_job(uuid, text, text, text, boolean)          FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fail_job(uuid, text, text, text, boolean)          TO service_role;

-- Verification. Expected for both: true, false, false.
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid)                AS signature,
       has_function_privilege('service_role',  p.oid, 'EXECUTE') AS service_role_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec,
       has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon_exec
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname IN ('complete_job', 'fail_job')
 ORDER BY p.proname;
