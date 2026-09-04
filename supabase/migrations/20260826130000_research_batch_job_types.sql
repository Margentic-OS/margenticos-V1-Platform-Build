-- Migration: the two research batch job types, their guards, and their flags
-- Date: 2026-08-26
--
-- Status: APPLIED (verified live 2026-08-26)
--
-- Read-back after apply:
--
--   job_queue_type_valid now CHECK (job_type IN ('enrich','research','compose',
--                                                'research_sources','research_collect'))
--   job_queue_one_live_research_per_prospect   present
--   system_flags_research_path_exclusive       present
--   enqueue_research_phase   SECURITY DEFINER = true
--     service_role  EXECUTE -> true
--     anon          EXECUTE -> false
--     authenticated EXECUTE -> false
--
-- The whole-database SECURITY DEFINER audit from CLAUDE.md returned zero rows: no
-- SECURITY DEFINER function in public is callable by anon.
--
-- Every guard broken on purpose, each inside BEGIN ... ROLLBACK:
--
--   a prospect waiting in research_collect, then a second enqueue as research_sources
--     -> 0 rows returned. A clean no-op, which is enqueue_job's contract.
--   the same, but going around the new function via enqueue_job
--     -> 23505 job_queue_one_live_research_per_prospect. This is the proof that the
--        hole is real AND that enqueue_job cannot serve these types.
--   the same, but enqueuing the OLD 'research' type during a batch wait
--     -> 23505. The flip-back window is closed.
--   enqueue_research_phase('enrich', ...)
--     -> P0001, named error refusing the wrong job type.
--   turning queue_research_sources on while queue_research is on
--     -> 23505 system_flags_research_path_exclusive.
--
-- And the intended rollout order works: queue_research off, then queue_research_collect
-- on, then queue_research_sources on. The drain valve is deliberately outside the
-- exclusion so it can be on alongside either path.
--
-- Live flag state was left exactly as found: queue_research true, both new keys false.
--
-- Splits research into two queue job types with a batch wait between them:
--
--   research_sources  fetch the four sources, snapshot, submit the synthesis calls
--   research_collect  read the synthesis out of the batch, run writer + floor + judge,
--                     write ONE complete prospect_research_results row
--
-- The existing single-job 'research' type is NOT removed, NOT renamed and NOT changed.
-- It stays registered and functional until a live batch proves the new path. Rollback is
-- a flag flip with no deploy.

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. THE JOB TYPE CHECK
--
-- job_type is checked rather than free text because an unrecognised value would sit
-- queued forever with no worker that knows how to claim it, and queue depth would rise
-- with no failure anywhere to explain it. Extending the list is therefore a migration,
-- deliberately, and not a code-only change.

ALTER TABLE job_queue DROP CONSTRAINT IF EXISTS job_queue_type_valid;
ALTER TABLE job_queue ADD CONSTRAINT job_queue_type_valid
  CHECK (job_type IN ('enrich','research','compose','research_sources','research_collect'));

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. ONE LIVE RESEARCH JOB PER PROSPECT, ACROSS ALL THREE RESEARCH TYPES
--
-- ── THIS IS THE 141-CREDIT SHAPE AND IT IS WHAT THE SPLIT REOPENS ──
--
-- job_queue already has job_queue_one_live_per_target, unique on
-- (job_type, prospect_id) where state in ('queued','claimed'). Note the job_type in
-- that key. Today one 'research' job holds the slot for the WHOLE run, so a second
-- operator click is a no-op.
--
-- After the split it is not. A prospect waiting 24 hours in research_collect does not
-- block a new research_sources job, because the job types differ. And during that wait
-- the prospect still has current_research_result_id IS NULL, because the research row is
-- deliberately not written until phase 2. So the 'unresearched' scope filter in
-- enqueue/research.ts selects it again.
--
-- One operator click during the wait would re-pay Apify, Apollo and Brave for every
-- prospect mid-flight. That is the same shape as the 10 August 2026 incident: 141
-- credits for 29 prospects against a ceiling of one per contact.
--
-- 'research' is in this list too, not just the two new types. The flags are mutually
-- exclusive (see section 5) so the two paths cannot both be enqueuing at once, but a
-- research_collect job can outlive a flag flip by up to 24 hours. Without 'research'
-- here, flipping back to the old path during that window would let an ordinary research
-- job re-fetch sources for a prospect whose sources are already bought and stored.

CREATE UNIQUE INDEX IF NOT EXISTS job_queue_one_live_research_per_prospect
  ON job_queue (prospect_id)
  WHERE state IN ('queued','claimed')
    AND job_type IN ('research','research_sources','research_collect');

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. THE ENQUEUE FUNCTION FOR THE BATCH PHASES
--
-- ── WHY enqueue_job COULD NOT JUST BE REUSED ──
--
-- enqueue_job ends with:
--
--     ON CONFLICT (job_type, prospect_id) WHERE state IN ('queued','claimed') DO NOTHING
--
-- That clause names ONE index. The new index in section 2 is a different one, so a
-- violation of it is not absorbed by that ON CONFLICT: it raises 23505, which propagates
-- out of enqueue_job and aborts the whole enqueue loop in enqueueJobsForProspects
-- mid-way, leaving a partial enqueue with an unhelpful error.
--
-- Rewriting enqueue_job's ON CONFLICT to cover both indexes would change a function the
-- PROVEN path depends on, and rollback safety is the whole reason the old path is still
-- there. So the batch phases get their own function and enqueue_job is not touched.
--
-- An EXCEPTION block rather than an ON CONFLICT clause, because it catches BOTH indexes
-- with one construct and needs no index inference. Zero rows returned means "already
-- live", which is exactly enqueue_job's contract, so the TypeScript wrapper reads the
-- same way for both.

CREATE OR REPLACE FUNCTION public.enqueue_research_phase(
  p_job_type        text,
  p_organisation_id uuid,
  p_prospect_id     uuid,
  p_enqueued_by     text,
  p_max_attempts    integer
)
RETURNS SETOF public.job_queue
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Refuses any other job type outright. This function skips enqueue_job's ON CONFLICT
  -- and relies on the research-family index instead, so pointing it at 'enrich' or
  -- 'compose' would quietly lose the per-type duplicate protection those types rely on.
  IF p_job_type NOT IN ('research_sources','research_collect') THEN
    RAISE EXCEPTION
      'enqueue_research_phase handles only research_sources and research_collect, got %. '
      'Use enqueue_job for every other job type.', p_job_type;
  END IF;

  RETURN QUERY
    INSERT INTO public.job_queue
      (job_type, organisation_id, prospect_id, enqueued_by, max_attempts)
    VALUES
      (p_job_type, p_organisation_id, p_prospect_id, p_enqueued_by, p_max_attempts)
    RETURNING *;

EXCEPTION WHEN unique_violation THEN
  -- This prospect already has a live job in the research family. Returning zero rows is
  -- a successful no-op, never an error: it is what stops a double click, a retried
  -- request, or an operator enqueuing during a batch wait from creating duplicate paid
  -- work.
  RETURN;
END;
$$;

-- SECURITY DEFINER bypasses RLS entirely, executing as the owner. Supabase's
-- ALTER DEFAULT PRIVILEGES has already granted EXECUTE to anon and authenticated BY NAME
-- at creation, so REVOKE ... FROM PUBLIC alone is a silent no-op. Name the roles.
REVOKE ALL ON FUNCTION public.enqueue_research_phase(text, uuid, uuid, text, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.enqueue_research_phase(text, uuid, uuid, text, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_research_phase(text, uuid, uuid, text, integer) TO service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. ROLLOUT FLAGS
--
-- queue_research_sources is seeded false. False means "the existing single-job research
-- path", which is the one already proven in production, and it is the answer to every
-- error in isQueueEnabled as well.
--
-- AMENDED 2026-09-04. queue_research_collect was ALSO seeded false and has been TRUE live
-- since 2026-08-26 (updated_by 'first-batch-runbook:drain-valve'). It now carries true.
-- DO NOTHING is unchanged; it protects a re-run and does not protect a rebuild, which is
-- why the literal had to move. Its own note says why false is the wrong value to rebuild
-- into: this is the DRAIN VALVE, and a rebuild that lands it false strands batches that
-- have already been submitted and already been paid for.
--
-- The exclusivity index below is unaffected: it permits at most one of queue_research and
-- queue_research_sources to be enabled, and only queue_research is true.

INSERT INTO system_flags (key, enabled, note) VALUES
  ('queue_research_sources', false,
   'THE BATCH PATH SWITCH. true routes research through the Batch API in two phases '
   '(research_sources then research_collect). false = the existing single-job research '
   'path. Mutually exclusive with queue_research, enforced by an index.'),
  ('queue_research_collect', true,
   'THE DRAIN VALVE. Lets the second phase claim work. DO NOT TURN THIS OFF TO ROLL '
   'BACK: turn queue_research_sources off instead, and leave this ON so batches already '
   'submitted and already paid for can still be collected. Turning this off strands '
   'them.')
ON CONFLICT (key) DO NOTHING;

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. THE TWO RESEARCH PATHS ARE MUTUALLY EXCLUSIVE. ENFORCED, NOT DOCUMENTED.
--
-- ── WHY THIS EXISTS: IT IS AN APIFY CONCURRENCY GUARANTEE, NOT TIDINESS ──
--
-- Measured live 2026-08-24: Apify allows 25 concurrent actor runs. The LinkedIn source
-- starts one actor per prospect, and maxInFlight counts claimed ROWS, so a job type's
-- maxInFlight IS its Apify concurrency.
--
-- Both 'research' and 'research_sources' fetch sources, so both start actors. With
-- research at 20 and research_sources at 20, having both enabled would allow 40
-- concurrent actor runs against a ceiling of 25, and the overshoot does not degrade
-- gracefully: Apify rejects the runs and the jobs fail.
--
-- The alternatives were to assert the SUM in assertQueueConfig, which would have forced
-- the proven path down from 20 to 15 to make room, or to assert the MAX and rely on
-- nobody enabling both. Asserting the max and PROVING the exclusion is strictly better
-- than either: the proven path keeps its measured configuration, and the assumption the
-- max relies on is a database guarantee rather than a convention someone has to
-- remember at 11pm.
--
-- A unique index on a constant expression is the standard way to say "at most one row
-- may satisfy this predicate". Verified live before it was written into this file:
-- with queue_research already true, an UPDATE turning queue_research_sources on was
-- refused with 23505.

CREATE UNIQUE INDEX IF NOT EXISTS system_flags_research_path_exclusive
  ON system_flags ((true))
  WHERE enabled AND key IN ('queue_research','queue_research_sources');
