-- Status: APPLIED (verified live 2026-09-02)
-- Backfill: reconstruct a run record for every historical sourcing run, and attribute
-- every prospect that one of them wrote.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- BY RUN WINDOW, NOT BY TIMESTAMP CLUSTERING. THIS IS THE WHOLE POINT.
--
-- The obvious backfill groups prospects by created_at and calls each cluster a batch. It
-- is wrong here, and measurably so. Clustering with a 30-minute gap threshold reports one
-- batch of 29 prospects on 2026-08-10. There were FOUR runs, 42, 27 and 85 seconds apart,
-- writing 25, 2, 1 and 1. No gap threshold separates them without also splitting the
-- 3-minute-long 25-prospect run into pieces. Clustering is an inference and it merges
-- exactly the case that matters.
--
-- agent_runs already records each run's start and end. A prospect belongs to the run whose
-- window contains its created_at. That is a LOOKUP, not an inference, and it was verified
-- before this migration was written: all 129 attributable prospects fall inside EXACTLY
-- ONE window, zero fall inside two, and the per-run counts match what each run recorded
-- having written: 25, 2, 1, 1, 100.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT IS DELIBERATELY NOT ATTRIBUTED
--
-- 1. FIVE completed runs have completed_at NULL, from a historical orchestrator bug that
--    inserted a terminal row without an end time. They are SKIPPED, not repaired with a
--    guessed end time. None of them wrote a prospect that still exists, so the skip costs
--    nothing today, and inventing a window would silently widen the net for whatever runs
--    near it later.
--
-- 2. NINETEEN prospects belong to no run: 12 in an organisation archived before run
--    logging existed, and 7 test fixtures. They keep sourcing_run_id NULL. The screen
--    shows them as unattributed rather than hiding them, because a total that silently
--    omits rows is the defect this whole change exists to remove.
--
-- 3. THREE runs recorded 25 written each and have ZERO surviving prospects. 75 prospects
--    were deleted at some point and nothing recorded it. Their run records are created
--    anyway, reading "written 25, present 0", which is honest and is itself information.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- COUNTS ARE PARSED OUT OF A PROSE LOG LINE, WHICH IS WHY backfilled_at EXISTS
--
-- output_summary reads "candidates returned 25, written 25, dropped 0 (suppressed: 0,
-- duplicate_person_key: 0, duplicate_linkedin: 0, duplicate_email: 0)". Every count below
-- comes from a regular expression over that sentence. It is the only record there is, and
-- it is not the same thing as a number written down as it happened. Every row this
-- migration creates is stamped backfilled_at so it can never be mistaken for one that was.

BEGIN;

-- ── target_batch_size becomes nullable, for backfilled rows only ──────────────
--
-- A live run always knows what was asked for. A reconstructed one often does not: the
-- orchestrator's log line records what CAME BACK, never what was requested. Inferring the
-- target from the outcome would be a guess dressed as a record, and "returned 25" is
-- equally consistent with a request for 25 and a request for 200 that found 25.
--
-- So NULL means unknown, and the CHECK keeps the guarantee where it is real: a row that
-- was not backfilled must still carry a target.
ALTER TABLE public.sourcing_runs ALTER COLUMN target_batch_size DROP NOT NULL;

ALTER TABLE public.sourcing_runs
  ADD CONSTRAINT sourcing_runs_live_rows_know_their_target
  CHECK (backfilled_at IS NOT NULL OR target_batch_size IS NOT NULL);

-- ── 1. One run record per usable historical run ───────────────────────────────
WITH usable AS (
  SELECT
    r.id AS agent_run_id,
    r.organisation_id,
    r.started_at,
    r.completed_at,
    r.output_summary,
    (regexp_match(r.output_summary, 'candidates returned (\d+)'))[1]::int      AS candidates_returned,
    (regexp_match(r.output_summary, 'written (\d+)'))[1]::int                  AS prospects_written,
    (regexp_match(r.output_summary, 'suppressed: (\d+)'))[1]::int              AS d_suppressed,
    (regexp_match(r.output_summary, 'duplicate_person_key: (\d+)'))[1]::int    AS d_person_key,
    (regexp_match(r.output_summary, 'duplicate_linkedin: (\d+)'))[1]::int      AS d_linkedin,
    (regexp_match(r.output_summary, 'duplicate_email: (\d+)'))[1]::int         AS d_email,
    -- The entry-point row for the same run, where one exists, is the ONLY place the
    -- requested size was ever recorded. Matched by overlapping window rather than by time
    -- proximity: the two rows are inserted within milliseconds of each other by the same
    -- call, so an overlap is exact rather than approximate. Absent for every run that
    -- predates the entry point, which is most of them.
    (
      SELECT (regexp_match(e.output_summary, 'target (\d+)'))[1]::int
      FROM public.agent_runs e
      WHERE e.agent_name = 'sourcing_entry'
        AND e.organisation_id = r.organisation_id
        AND e.started_at <= r.completed_at
        AND COALESCE(e.completed_at, e.started_at) >= r.started_at
      ORDER BY e.started_at
      LIMIT 1
    ) AS target_batch_size
  FROM public.agent_runs r
  WHERE r.agent_name = 'sourcing_orchestrator'
    AND r.status = 'completed'
    AND r.completed_at IS NOT NULL          -- the five NULL-ended rows are skipped here
    AND r.output_summary IS NOT NULL
)
INSERT INTO public.sourcing_runs (
  organisation_id, started_at, completed_at, status,
  target_batch_size, candidates_returned, prospects_written,
  dropped_by_reason, trigger_type, agent_run_id, backfilled_at
)
SELECT
  u.organisation_id,
  u.started_at,
  u.completed_at,
  'completed',
  u.target_batch_size,
  COALESCE(u.candidates_returned, 0),
  COALESCE(u.prospects_written, 0),
  -- Only reasons that actually fired. A zero is not recorded, so the object says what
  -- happened rather than restating the whole vocabulary on every row.
  COALESCE((
    SELECT jsonb_object_agg(k, v)
    FROM (VALUES
      ('suppressed_match',       u.d_suppressed),
      ('duplicate_person_key',   u.d_person_key),
      ('duplicate_linkedin',     u.d_linkedin),
      ('duplicate_email',        u.d_email)
    ) AS t(k, v)
    WHERE v IS NOT NULL AND v > 0
  ), '{}'::jsonb),
  'backfilled',
  u.agent_run_id,
  now()
FROM usable u;

-- ── 2. Attribute every prospect that falls inside exactly one window ──────────
--
-- Scoped by organisation_id as well as by time. Two organisations can source in the same
-- second and nothing about a timestamp says whose prospect it is.
UPDATE public.prospects p
SET sourcing_run_id = s.id
FROM public.sourcing_runs s
WHERE s.backfilled_at IS NOT NULL
  AND p.organisation_id = s.organisation_id
  AND p.created_at >= s.started_at
  AND p.created_at <= s.completed_at
  AND p.sourcing_run_id IS NULL;

COMMIT;
