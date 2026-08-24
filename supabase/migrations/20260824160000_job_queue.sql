-- Migration: create job_queue, system_flags, and the atomic claim/lease primitives
-- Date: 2026-08-24
--
-- Status: APPLIED (verified live 2026-08-24)
--
-- INCOMPLETE ON ITS OWN. The function grant block at the bottom of this file revokes
-- FROM PUBLIC only, which on Supabase is a silent no-op: ALTER DEFAULT PRIVILEGES has
-- already granted EXECUTE to anon and authenticated explicitly, and revoking PUBLIC
-- does not remove a named-role grant. All eight functions are SECURITY DEFINER, so
-- they bypass RLS. 20260824160500_job_queue_revoke_anon_authenticated.sql closes it
-- and explains it in full.
--
-- DO NOT COPY THE GRANT BLOCK AT THE BOTTOM OF THIS FILE AS A TEMPLATE. Copy the one
-- in 20260824160500 instead, which names the roles.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY THIS TABLE EXISTS AND WHY IT IS NOT agent_runs
--
-- READ THIS BEFORE PROPOSING A MERGE. The next person to look at these two tables
-- will see overlap and try to combine them. Do not.
--
-- agent_runs is a HISTORY table. Its columns are id, organisation_id, agent_name,
-- status, started_at, completed_at, duration_ms, output_summary, error_message.
-- It is written after the fact to record that something ran. It has:
--     no claim state    - nothing marks a row as "this worker is doing it now"
--     no lease          - nothing expires, so a dead worker's row stays stuck forever
--     no attempt count  - nothing can cap retries or terminate a failing job
--     no spend record   - nothing knows whether an external paid call already returned
--
-- Those four are the entire substance of a durable queue. Adding them to agent_runs
-- would give one table two meanings: "what happened" and "what is happening". That
-- is the failure class that has cost this build the most time. agent_runs stays
-- exactly as it is and continues to be the history. job_queue is the work list.
--
-- Both are written during a job. agent_runs answers "what did we run and when".
-- job_queue answers "what is owed, who holds it, what has it cost, and what is next".
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT THIS REPLACES
--
-- Today enrich, research and compose all run inside a single web request. Vercel
-- kills any request at 300s. Research is measured at 46.8s per prospect wall clock
-- (FRESH_SECONDS_PER_PROSPECT in src/lib/operator/research-batch-entry.ts), so one
-- request admits about 5 prospects. At scale that is hundreds of manual clicks.
--
-- The inline paths are NOT removed by this migration. They stay in place behind an
-- explicit database flag (system_flags below) until each job type is proven live.
-- Rolling back is one UPDATE, with no deploy.

-- ═════════════════════════════════════════════════════════════════════════════
-- SYSTEM FLAGS
--
-- Rollout control for the queue, one row per job type.
--
-- WHY A NEW TABLE AND NOT integrations_registry.config. integrations_registry is
-- keyed by CAPABILITY and holds tool configuration (which vendor answers
-- can_enrich_contact, and how it is set up). Queue rollout is not a capability and
-- has no vendor. Putting it there would repeat the one-table-two-meanings mistake
-- described above, one level down.
--
-- WHY A DATABASE FLAG AND NEVER AN ENVIRONMENT VARIABLE. Per CLAUDE.md, mode is
-- never inferred from NODE_ENV, VERCEL_URL, or the presence or absence of a key.
-- Inferred modes cannot be audited, cannot be flipped without a deploy, and drift
-- silently from whatever the UI claims. Same discipline as enrichment_live.

CREATE TABLE IF NOT EXISTS system_flags (
  key         text        PRIMARY KEY,

  -- DEFAULT false is the safe value and it is load-bearing. A flag row that appears
  -- through some future path with no explicit value must mean "inline path", because
  -- the inline path is the one that is already proven.
  enabled     boolean     NOT NULL DEFAULT false,

  -- Plain English. This table is read by humans deciding whether to flip something.
  note        text,

  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- Who flipped it. Free text, not a FK: the flipper may be a person, a script, or
  -- the queue's own credit-exhaustion circuit breaker.
  updated_by  text
);

INSERT INTO system_flags (key, enabled, note) VALUES
  ('queue_enrich',   false, 'Route Apollo enrichment through job_queue instead of running it inline in the request. false = inline path.'),
  ('queue_research', false, 'Route prospect research through job_queue instead of running it inline in the request. false = inline path.'),
  ('queue_compose',  false, 'Route sequence composition through job_queue instead of running it inline in handleUploadLeads. false = inline path.')
ON CONFLICT (key) DO NOTHING;

-- ═════════════════════════════════════════════════════════════════════════════
-- JOB QUEUE

CREATE TABLE IF NOT EXISTS job_queue (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which handler runs this. Checked, not free text: an unrecognised job_type would
  -- sit queued forever with no worker that knows how to claim it, and queue depth
  -- would rise with no failure anywhere to explain it.
  job_type          text        NOT NULL,

  -- Agent isolation, per CLAUDE.md. NOT NULL with no exception. This is also the
  -- per-organisation fairness key: the worker claims per organisation so a large
  -- batch for one client cannot starve a small batch for another.
  organisation_id   uuid        NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,

  -- The target. One row per prospect, which is what makes failures isolated: a
  -- prospect that fails writes its error to its own row and touches no other.
  -- CASCADE because a job for a deleted prospect has nothing left to act on.
  prospect_id       uuid        NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,

  state             text        NOT NULL DEFAULT 'queued',

  -- ── Lease, not lock ──────────────────────────────────────────────────────
  -- A claim carries an expiry rather than an indefinite hold. A worker that dies
  -- mid-job leaves a row whose lease runs out, and reclaim_expired_jobs below puts
  -- it back. An indefinite lock would strand the row forever, which is precisely
  -- what the 30-minute stale-lock reclaim in enrichment-trigger.ts exists to avoid.
  --
  -- Reclaim MUST NOT re-spend money. See spend_recorded_at below.
  claimed_by        text,
  lease_expires_at  timestamptz,

  -- ── Retry cap ────────────────────────────────────────────────────────────
  -- attempts is incremented AT CLAIM TIME, not at completion. A worker that dies
  -- has still burned an attempt. Incrementing on completion instead would let a job
  -- that reliably kills its worker be reclaimed forever, which is the infinite loop
  -- on a paid API that this design exists to prevent.
  attempts          integer     NOT NULL DEFAULT 0,

  -- Per-row rather than a global constant, so an expensive job type can be capped
  -- tighter than a cheap one without a code change or a migration.
  max_attempts      integer     NOT NULL DEFAULT 3,

  -- Backoff scheduling. The claim only sees rows where run_after <= now(), so a
  -- failed job simply becomes invisible until its backoff elapses.
  run_after         timestamptz NOT NULL DEFAULT now(),

  -- ── Failure record ───────────────────────────────────────────────────────
  last_error        text,

  -- Classified explicitly at the point of failure, never re-derived later from the
  -- error string. A 429 or 529 backs off and retries; a 400 or an auth failure is
  -- terminal. Treating both the same either loses work or burns money.
  last_error_class  text,

  -- ── PAY-BEFORE-WORK RECORDING ────────────────────────────────────────────
  --
  -- Set the instant an external paid call returns, BEFORE any parsing, mapping or
  -- database write that can throw. This is the fix pattern from commit 3de0589.
  --
  -- The Apollo re-spend bug was a crash mid-job that left the work claimable and
  -- payable twice: the money left at the START of the run and the status was written
  -- at the END, so every failure path in between left a row that looked untouched.
  -- Aug 10 2026: 141 credits for 29 prospects, 4.86 each, against Apollo's ceiling
  -- of 1 per contact.
  --
  -- ENFORCEMENT: a reclaimed job with spend_recorded_at already set does NOT call
  -- the paid API again. It goes straight to terminal 'failed'. We cannot reconstruct
  -- a response we already paid for, and calling again is exactly the bug. A terminal
  -- failure with a named cause is honest and stops the loop.
  spend_recorded_at timestamptz,

  -- What it cost: credits, tokens, actor run id. Free-form because the three job
  -- types measure spend in different units.
  --
  -- DELIBERATELY NOT CONSTRAINED against spend_recorded_at. It is tempting to
  -- require that a stamped row also carry detail. Do not add that constraint: the
  -- stamp is written in the microseconds after money leaves, and a constraint
  -- violation at that exact moment would abort the one write that prevents paying
  -- twice. The recording path must be incapable of throwing.
  spend_detail      jsonb,

  result_summary    text,

  -- Which surface enqueued this. Needed for the rollback story: while a flag is
  -- being flipped back and forth, this is how you tell queue-era rows from any
  -- other source without guessing from timestamps.
  enqueued_by       text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT job_queue_type_valid
    CHECK (job_type IN ('enrich', 'research', 'compose')),

  CONSTRAINT job_queue_state_valid
    CHECK (state IN ('queued', 'claimed', 'done', 'failed', 'cancelled')),

  CONSTRAINT job_queue_error_class_valid
    CHECK (last_error_class IS NULL OR last_error_class IN ('transient', 'permanent')),

  CONSTRAINT job_queue_attempts_sane
    CHECK (attempts >= 0 AND max_attempts > 0),

  -- A claimed row must name its holder and its expiry, or the lease means nothing
  -- and reclaim cannot find it. Terminal rows KEEP both fields for forensics, which
  -- is why this only constrains the 'claimed' case.
  CONSTRAINT job_queue_claim_fields_consistent
    CHECK (
      state <> 'claimed'
      OR (claimed_by IS NOT NULL AND lease_expires_at IS NOT NULL)
    ),

  -- A terminal failure with no stated reason is a silent failure, which is the exact
  -- class this whole build is fighting. Enforced rather than trusted to the caller.
  CONSTRAINT job_queue_failed_has_error
    CHECK (state <> 'failed' OR last_error IS NOT NULL)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- IDEMPOTENCY
--
-- One LIVE job per (job_type, prospect_id). Running the same job twice must not
-- produce two research rows, two compositions, or two Apollo charges.
--
-- Partial on the live states only, so a finished job never blocks a later, genuinely
-- intended re-run of the same prospect. Enqueue uses ON CONFLICT DO NOTHING against
-- this index, so a double click, a retried request, or two overlapping enqueue calls
-- collapse to one row at the database level rather than in application logic.
--
-- This is the first of three idempotency layers. The second is spend_recorded_at
-- above. The third is per-handler: research checks current_research_result_id,
-- enrich checks enrichment_credit_consumed_at, and composition is a pure function of
-- the approved documents and the prospect.
CREATE UNIQUE INDEX IF NOT EXISTS job_queue_one_live_per_target
  ON job_queue (job_type, prospect_id)
  WHERE state IN ('queued', 'claimed');

-- The claim path, and the per-organisation fairness scan that precedes it. Partial
-- on 'queued' so the index stays small as done and failed rows accumulate: at
-- 3,333 jobs per batch the finished rows would otherwise dominate every claim.
CREATE INDEX IF NOT EXISTS job_queue_claim_idx
  ON job_queue (job_type, organisation_id, run_after, created_at)
  WHERE state = 'queued';

-- The reclaim path. Partial on 'claimed' for the same reason: only claimed rows can
-- have an expired lease, and they are a small fraction of the table.
CREATE INDEX IF NOT EXISTS job_queue_lease_idx
  ON job_queue (lease_expires_at)
  WHERE state = 'claimed';

-- Monitoring: queue depth, oldest queued age, completion and failure counts in a
-- trailing window. Read by the mon_016/017/018 views.
CREATE INDEX IF NOT EXISTS job_queue_state_updated_idx
  ON job_queue (job_type, state, updated_at);

-- Postgres does not index foreign keys automatically. Without this, deleting a
-- prospect sequentially scans job_queue to find the rows to cascade.
CREATE INDEX IF NOT EXISTS job_queue_prospect_idx
  ON job_queue (prospect_id);

-- ═════════════════════════════════════════════════════════════════════════════
-- BACKOFF
--
-- ONE definition, in SQL, used by every path that reschedules a job. It lives here
-- rather than in TypeScript because both reclaim_expired_jobs and fail_job need it,
-- and two copies of a retry formula drift.
--
-- Exponential with jitter: 30s base, doubling, capped at 15 minutes. The jitter is
-- what stops a batch that all failed together from all retrying together.
--
--   attempt 1 -> 60s      attempt 2 -> 120s     attempt 3 -> 240s
--   (each then multiplied by a random factor between 1.0 and 1.3)
--
-- NOT marked IMMUTABLE, because random() is volatile. Marking it immutable would
-- let the planner evaluate it once and give every row in a batch the same delay,
-- which removes the jitter entirely.
CREATE OR REPLACE FUNCTION public.job_queue_backoff(p_attempts integer)
RETURNS interval
LANGUAGE sql
VOLATILE
AS $$
  SELECT make_interval(
    secs => least(power(2, greatest(p_attempts, 0))::double precision * 30.0, 900.0)
            * (1.0 + random() * 0.3)
  );
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- ENQUEUE
--
-- Idempotent by construction. Returns the row when it inserted one, nothing when
-- the target already had a live job. The caller distinguishes "queued it" from
-- "already queued" by whether a row came back, never by catching an error.

CREATE OR REPLACE FUNCTION public.enqueue_job(
  p_job_type        text,
  p_organisation_id uuid,
  p_prospect_id     uuid,
  p_enqueued_by     text,
  p_max_attempts    integer DEFAULT 3
)
RETURNS SETOF public.job_queue
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO public.job_queue (job_type, organisation_id, prospect_id, enqueued_by, max_attempts)
  VALUES (p_job_type, p_organisation_id, p_prospect_id, p_enqueued_by, p_max_attempts)
  ON CONFLICT (job_type, prospect_id) WHERE state IN ('queued', 'claimed')
  DO NOTHING
  RETURNING *;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- ATOMIC CLAIM
--
-- Two workers must never take the same job. This is a SINGLE statement: an
-- UPDATE ... RETURNING, never a SELECT followed by an UPDATE. Between a separate
-- SELECT and UPDATE another worker reads the same rows and both proceed.
--
-- FOR UPDATE SKIP LOCKED in the subquery is what makes concurrent workers take
-- DISJOINT sets. The second transaction skips rows the first has locked rather than
-- blocking on them, so neither waits and neither collides.
--
-- The outer  AND q.state = 'queued'  is redundant while SKIP LOCKED is present. It
-- stays because it costs nothing and it is the guard that survives if someone edits
-- the subquery later without understanding what SKIP LOCKED was doing.
--
-- This has to be a database function because supabase-js cannot express
-- FOR UPDATE SKIP LOCKED through PostgREST.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY p_limit EXISTS: THE ENRICHMENT BATCH-CLAIM TRADE-OFF
--
-- Apollo's people/bulk_match takes TEN people per call and returns ONE
-- credits_consumed figure for the whole batch. It never says which individual
-- record was billed.
--
-- So enrichment claims up to ten rows of the SAME organisation in one call to this
-- function, and the handler issues one Apollo call for all of them. One row per
-- prospect is kept because retry state, spend state and error state are all
-- genuinely per-prospect. But be precise about what isolation that buys:
--
--   ISOLATED:     a per-prospect failure. No match, unverified email, dedupe hit.
--                 Each writes to its own row and touches no other.
--   NOT ISOLATED: a transport-level failure of the shared HTTP call. All ten rows
--                 in that claim fail together, because there was one call and it
--                 did not return.
--
-- The alternative is one Apollo call per prospect, which is ten times the calls
-- against a 600/hour limit, and still cannot attribute credits per record because
-- Apollo does not report them that way. This trade-off is accepted deliberately.
-- Research and compose claim with p_limit sized to their own concurrency instead.

CREATE OR REPLACE FUNCTION public.claim_jobs(
  p_job_type        text,
  p_organisation_id uuid,
  p_worker          text,
  p_lease_seconds   integer,
  p_limit           integer
)
RETURNS SETOF public.job_queue
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.job_queue q
     SET state            = 'claimed',
         claimed_by       = p_worker,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         attempts         = q.attempts + 1,
         updated_at       = now()
   WHERE q.id IN (
           SELECT id
             FROM public.job_queue
            WHERE job_type        = p_job_type
              AND organisation_id = p_organisation_id
              AND state           = 'queued'
              AND run_after      <= now()
            ORDER BY created_at
            LIMIT p_limit
            FOR UPDATE SKIP LOCKED
         )
     AND q.state = 'queued'
  RETURNING q.*;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- PER-ORGANISATION FAIRNESS
--
-- The worker calls this first, then claims from each organisation in the order
-- returned, taking a bounded slice from each.
--
-- WHY NOT PLAIN FIFO. Ordering the whole queue by created_at hands one client's
-- 3,333 rows every slot until they drain. A second client's 10-prospect run would
-- wait behind all of them. Slicing per organisation per tick bounds that wait to
-- roughly (number of active organisations x tick interval), independent of how deep
-- the largest batch is.
--
-- WHY NOT row_number() OVER (PARTITION BY organisation_id) INSIDE THE CLAIM. It is
-- one statement instead of two, but it ranks the entire queued set on every claim,
-- so it gets slower exactly as the queue gets deeper. This form reads a grouped
-- count off the partial index and then claims by index.
--
-- Ordered by oldest job, so an organisation that has been waiting longest goes
-- first. depth is returned so the worker can log what it is choosing between.
CREATE OR REPLACE FUNCTION public.queue_next_organisations(p_job_type text)
RETURNS TABLE (organisation_id uuid, oldest timestamptz, depth bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT q.organisation_id, min(q.created_at) AS oldest, count(*) AS depth
    FROM public.job_queue q
   WHERE q.job_type   = p_job_type
     AND q.state      = 'queued'
     AND q.run_after <= now()
   GROUP BY q.organisation_id
   ORDER BY min(q.created_at);
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- RECORD SPEND
--
-- Called the moment an external paid call returns and before anything that can
-- fail. Deliberately trivial: one UPDATE, no joins, no validation, no constraint it
-- can violate. Every line of complexity here is a new way to fail at the one moment
-- failure costs money.
--
-- Scoped  WHERE spend_recorded_at IS NULL  so a reclaimed job never overwrites the
-- timestamp of the spend that already happened. The first stamp is the true one.
CREATE OR REPLACE FUNCTION public.record_job_spend(
  p_job_id uuid,
  p_detail jsonb
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.job_queue
     SET spend_recorded_at = now(),
         spend_detail      = p_detail,
         updated_at        = now()
   WHERE id = p_job_id
     AND spend_recorded_at IS NULL;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- COMPLETE

CREATE OR REPLACE FUNCTION public.complete_job(
  p_job_id  uuid,
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
   WHERE id    = p_job_id
     AND state = 'claimed'
  RETURNING *;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- FAIL
--
-- The whole retry policy in one place.
--
--   permanent          -> terminal immediately, whatever the attempt count.
--                         A malformed request or an auth failure will fail
--                         identically every time; retrying it burns money and time
--                         to reach the same answer.
--   transient, capped  -> terminal. The cap is what stops a job looping forever on
--                         a paid API.
--   transient, under   -> back to queued, invisible until the backoff elapses.
--
-- p_force_terminal exists for one case: a reclaimed job that already has
-- spend_recorded_at set. It is not a permanent error in the API sense, but it must
-- never be retried, because retrying means paying twice.
CREATE OR REPLACE FUNCTION public.fail_job(
  p_job_id          uuid,
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
                   WHEN p_force_terminal            THEN 'failed'
                   WHEN p_error_class = 'permanent' THEN 'failed'
                   WHEN q.attempts >= q.max_attempts THEN 'failed'
                   ELSE 'queued'
                 END,
         last_error       = p_error,
         last_error_class = p_error_class,
         run_after        = now() + public.job_queue_backoff(q.attempts),
         lease_expires_at = NULL,
         updated_at       = now()
   WHERE q.id    = p_job_id
     AND q.state = 'claimed'
  RETURNING q.*;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- RECLAIM EXPIRED LEASES
--
-- A worker that died mid-job leaves a claimed row whose lease runs out. This puts
-- it back, or terminates it if it has already used its attempts.
--
-- WHY THE WORKER IS NOT RESUMABLE MID-JOB, WHICH IS WHY THIS EXISTS.
--
-- A research job is one continuous chain of paid calls: Apify actors, then
-- synthesis, then write, then judge. Measured at 46.8s per prospect at concurrency
-- 5, one prospect is roughly 156 to 234 seconds of its own wall clock. Making that
-- resumable would mean persisting every intermediate Apify and Anthropic result and
-- re-entering the chain partway through. That is a much larger build, and it
-- reopens the exact double-spend surface the lease exists to close: a half-finished
-- job that is re-entered has to decide, per step, whether that step was already
-- paid for.
--
-- So each worker invocation FINISHES the jobs it claims, inside 300s. It takes a
-- deadline budget and stops claiming once the time left cannot fit another
-- worst-case job. A worker that dies anyway is handled HERE, by the lease, not by
-- resumption. The cost of that choice is that a death loses the work in flight and
-- burns one attempt. The benefit is that there is exactly one place where "have we
-- already paid" is asked, and it is spend_recorded_at.
--
-- Backoff is applied on reclaim too. Re-queueing a dead worker's job immediately
-- would loop fast against whatever killed the worker.
--
-- claimed_by is cleared so that state stays unambiguous: a queued row is held by
-- nobody. The dead worker's identity is preserved in last_error instead, so the
-- forensic trail survives without overloading a column.
CREATE OR REPLACE FUNCTION public.reclaim_expired_jobs(p_limit integer DEFAULT 100)
RETURNS SETOF public.job_queue
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.job_queue q
     SET state = CASE
                   WHEN q.attempts >= q.max_attempts THEN 'failed'
                   ELSE 'queued'
                 END,
         last_error = 'Lease expired at '
                      || to_char(q.lease_expires_at, 'YYYY-MM-DD HH24:MI:SS UTC')
                      || ' while held by ' || coalesce(q.claimed_by, 'unknown worker')
                      || '. Attempt ' || q.attempts || ' of ' || q.max_attempts || '.'
                      || CASE
                           WHEN q.spend_recorded_at IS NOT NULL
                             THEN ' Spend was already recorded for this job, so it must not call the paid API again.'
                           ELSE ''
                         END,
         last_error_class = 'transient',
         run_after        = now() + public.job_queue_backoff(q.attempts),
         claimed_by       = NULL,
         lease_expires_at = NULL,
         updated_at       = now()
   WHERE q.id IN (
           SELECT id
             FROM public.job_queue
            WHERE state             = 'claimed'
              AND lease_expires_at <= now()
            ORDER BY lease_expires_at
            LIMIT p_limit
            FOR UPDATE SKIP LOCKED
         )
     AND q.state = 'claimed'
  RETURNING q.*;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- ACCESS: SERVICE ROLE ONLY
--
-- Same shape as suppressed_emails and integration_credentials: RLS enabled with
-- ZERO policies, so no authenticated user reaches these tables at all. There is no
-- client-facing surface for either and there must never be one. The worker, the
-- enqueue paths and the monitor views all run with the service client.

ALTER TABLE job_queue    ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_flags ENABLE ROW LEVEL SECURITY;

-- No SELECT / INSERT / UPDATE / DELETE policies. Intentional.

REVOKE ALL ON public.job_queue    FROM anon, authenticated;
REVOKE ALL ON public.system_flags FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON public.job_queue    TO service_role;
GRANT SELECT, UPDATE           ON public.system_flags TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- FUNCTION GRANTS
--
-- Standing rule from CLAUDE.md, learned 2026-06-05: every REVOKE ships with an
-- explicit GRANT to each legitimate caller, verified with has_function_privilege
-- before committing. The 2026-06-05 incident was a REVOKE that removed PUBLIC
-- access to approve_document_suggestion without granting service_role back, and
-- every Approve click failed silently for days.
--
-- The only caller of all eight functions is service_role. The worker route owns its
-- own auth gate (Bearer CRON_SECRET) and the enqueue paths run behind the operator
-- gate, so nothing here is called by authenticated directly. pg_cron is NOT granted:
-- the scheduled job posts to the HTTP route, it does not call these functions.

-- WARNING: THE REVOKES BELOW ARE NOT SUFFICIENT ON SUPABASE. Kept as applied, for
-- history. See 20260824160500_job_queue_revoke_anon_authenticated.sql, which names
-- anon and authenticated explicitly. A replay of this repo applies both in order and
-- lands correct; this file alone does not.

REVOKE ALL ON FUNCTION public.job_queue_backoff(integer)                              FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enqueue_job(text, uuid, uuid, text, integer)            FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_jobs(text, uuid, text, integer, integer)          FROM PUBLIC;
REVOKE ALL ON FUNCTION public.queue_next_organisations(text)                          FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_job_spend(uuid, jsonb)                           FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_job(uuid, text)                                FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fail_job(uuid, text, text, boolean)                     FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reclaim_expired_jobs(integer)                           FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.job_queue_backoff(integer)                           TO service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_job(text, uuid, uuid, text, integer)         TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_jobs(text, uuid, text, integer, integer)       TO service_role;
GRANT EXECUTE ON FUNCTION public.queue_next_organisations(text)                       TO service_role;
GRANT EXECUTE ON FUNCTION public.record_job_spend(uuid, jsonb)                        TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_job(uuid, text)                             TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_job(uuid, text, text, boolean)                  TO service_role;
GRANT EXECUTE ON FUNCTION public.reclaim_expired_jobs(integer)                        TO service_role;
