-- Migration: mon_019, mon_020 and mon_021 stop quoting a failure from all of history
-- Status: PENDING
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE DEFECT
-- ─────────────────────────────────────────────────────────────────────────────
--
-- These three views compute STATE over a bounded window and DETAIL over an
-- unbounded one:
--
--     state:   bool_or(NOT ok) FILTER (WHERE ran_at > now() - interval '1 hour')
--     detail:  COALESCE(max(CASE WHEN ok = false THEN detail END), 'Last run: ' || ...)
--
-- The max() in the detail has NO TIME FILTER. It is the alphabetically largest
-- failure message from ALL of history. So one failed run pins that sentence as
-- the displayed detail for ever, while the state correctly recovers to OK.
-- State and detail come from different rows, days or weeks apart.
--
-- This is the SAME defect 20260904190000_monitor_state_reads_latest_run.sql
-- fixed for mon_001..005, 010 and 016 earlier today. That migration explicitly
-- left these three alone, because it was changing STATE shape and these three
-- deliberately keep the window shape. The detail half of the defect was left
-- behind with them. This migration finishes the job and changes no state logic.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- MEASURED ON PRODUCTION, 2026-09-04
-- ─────────────────────────────────────────────────────────────────────────────
--
-- MON-020 is the TRIGGERED instance. Both the dashboard and the live view read:
--
--     "BOUNCER_API_KEY is not set, so no second-pass verification can run."
--
-- That is false, and has been for nine days:
--
--   cron_heartbeats, job_name = 'verify-catch-all'
--     ok = false : 1 row, 2026-08-26 02:00:01          <- the whole cause
--     ok = true  : 770 rows, through 2026-09-04 22:10
--
--   verification_calls
--     provider 'bouncer', outcome 'ok' : 52 rows, ZERO failures,
--     first 2026-08-26 02:30:00, last 2026-09-02 15:40:01
--
--   BOUNCER_API_KEY is present in the Vercel Production scope.
--
-- The key was set between 02:00 and 02:30 that morning. The first successful
-- paid call is 29 minutes after the only failure this job has ever recorded.
--
-- MON-019 and MON-021 are LATENT, NOT HARMLESS. Neither has ever failed:
--
--   verify-pending         : 0 failures, 1431 successes
--   synthesis-batch-sweep  : 0 failures, 2599 successes
--
-- The first failure either one ever records becomes its permanent detail line,
-- exactly as MON-020's did. Fixing only the view that has already fired would
-- leave two loaded. This is why all three are in one migration.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- mon_021 IS A WEAKER VARIANT, AND THE DIFFERENCE MATTERS
-- ─────────────────────────────────────────────────────────────────────────────
--
-- mon_019 and mon_020 use COALESCE, so the stale failure string outranks the
-- healthy "Last run" text unconditionally: they show a failure sentence while
-- green. That is what MON-020 has been doing.
--
-- mon_021 reaches its failure_detail only inside "WHEN hb.recent_failure THEN",
-- and recent_failure IS windowed. So mon_021 can never show a failure while
-- green. What it CAN do is show the WRONG failure: when a genuine failure
-- happens, the sentence displayed is the lexicographic max over all history,
-- not the failure that just occurred. Narrower, still wrong, and worse in the
-- one moment the view exists for.
--
-- Fixing all three the same way is still correct. Recording that they were not
-- identical is the part a later reader needs.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE FIX
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Resolve the LATEST FAILING RUN WITHIN THE SAME WINDOW THE STATE USES, via a
-- LEFT JOIN LATERAL, and quote that row. The window in the lateral and the
-- window in the FILTER must stay equal: if they ever drift, the state can say
-- PROBLEM while the detail has nothing to quote. They are written adjacently in
-- each view below for exactly that reason.
--
-- STATE LOGIC IS UNCHANGED IN ALL THREE VIEWS. Thresholds (20/90/15 minutes),
-- windows (1h/2h/1h) and every PROBLEM condition are carried across verbatim.
-- This migration is a detail-line fix only.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- TWO PROPERTIES THAT MUST NOT BE LOST (inherited from 20260904190000)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 1. EXACTLY ONE ROW, ALWAYS. The sweep calls .single(), which errors on zero
--    rows and would be counted as a failed check rather than as UNKNOWN. The
--    bare aggregate subqueries below return one row even when the job has never
--    run, and LEFT JOIN LATERAL cannot remove it. Do not rewrite the aggregate
--    as a plain SELECT over the heartbeat table.
--
-- 2. THE COLUMN LIST. check_code, state, detail, last_run, in that order. The
--    sweep selects check_code, state and detail by name, and the operator
--    dashboard now also selects last_run by name.
--
-- Tie-break on "ran_at DESC, id DESC" so "the latest failure" is a defined row
-- rather than a coin toss, matching the six views fixed earlier today.
--
-- CREATE OR REPLACE VIEW preserves ownership and existing grants, so this
-- migration changes no privileges. Read back after applying to confirm.
--
-- The job_name literals are pre-existing values in cron_heartbeats.job_name that
-- these views already filtered on. They are data, not new vendor references, and
-- changing one would silently detach a monitor from the job it watches.


-- ──────────────────────────────────────────────────────────────────────────────
-- MON-019: verify-pending, every 10 minutes, stale after 20, failure window 1h
-- ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.mon_019 AS
  SELECT
    'MON-019'::text AS check_code,
    CASE
      WHEN agg.last_run IS NULL THEN 'UNKNOWN'
      WHEN EXTRACT(EPOCH FROM (now() - agg.last_run)) / 60 > 20 THEN 'PROBLEM'
      WHEN agg.recent_failure THEN 'PROBLEM'
      ELSE 'OK'
    END AS state,
    CASE
      WHEN agg.last_run IS NULL
        THEN 'verify-pending has never reported. Check the pg_cron job exists and is active.'
      WHEN EXTRACT(EPOCH FROM (now() - agg.last_run)) / 60 > 20
        THEN 'Last run ' || TO_CHAR(agg.last_run, 'YYYY-MM-DD HH24:MI:SS UTC') || ', over 20 minutes ago.'
      WHEN agg.recent_failure
        THEN 'Run at ' || TO_CHAR(fail.ran_at, 'YYYY-MM-DD HH24:MI:SS UTC')
             || ' FAILED: ' || COALESCE(fail.detail, 'no detail')
      ELSE 'Last run: ' || TO_CHAR(agg.last_run, 'YYYY-MM-DD HH24:MI:SS UTC')
    END AS detail,
    agg.last_run
  FROM (
    SELECT
      max(h.ran_at) AS last_run,
      bool_or(NOT h.ok) FILTER (WHERE h.ran_at > now() - interval '1 hour') AS recent_failure
    FROM public.cron_heartbeats h
    WHERE h.job_name = 'verify-pending'
  ) agg
  LEFT JOIN LATERAL (
    SELECT h.ran_at, h.detail
      FROM public.cron_heartbeats h
     WHERE h.job_name = 'verify-pending'
       AND NOT h.ok
       AND h.ran_at > now() - interval '1 hour'   -- must equal the FILTER window above
     ORDER BY h.ran_at DESC, h.id DESC
     LIMIT 1
  ) fail ON true;


-- ──────────────────────────────────────────────────────────────────────────────
-- MON-020: verify-catch-all, every 30 minutes, stale after 90, failure window 2h
-- ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.mon_020 AS
  SELECT
    'MON-020'::text AS check_code,
    CASE
      WHEN agg.last_run IS NULL THEN 'UNKNOWN'
      WHEN EXTRACT(EPOCH FROM (now() - agg.last_run)) / 60 > 90 THEN 'PROBLEM'
      WHEN agg.recent_failure THEN 'PROBLEM'
      ELSE 'OK'
    END AS state,
    CASE
      WHEN agg.last_run IS NULL
        THEN 'verify-catch-all has never reported. Check the pg_cron job exists and is active.'
      WHEN EXTRACT(EPOCH FROM (now() - agg.last_run)) / 60 > 90
        THEN 'Last run ' || TO_CHAR(agg.last_run, 'YYYY-MM-DD HH24:MI:SS UTC') || ', over 90 minutes ago.'
      WHEN agg.recent_failure
        THEN 'Run at ' || TO_CHAR(fail.ran_at, 'YYYY-MM-DD HH24:MI:SS UTC')
             || ' FAILED: ' || COALESCE(fail.detail, 'no detail')
      ELSE 'Last run: ' || TO_CHAR(agg.last_run, 'YYYY-MM-DD HH24:MI:SS UTC')
    END AS detail,
    agg.last_run
  FROM (
    SELECT
      max(h.ran_at) AS last_run,
      bool_or(NOT h.ok) FILTER (WHERE h.ran_at > now() - interval '2 hours') AS recent_failure
    FROM public.cron_heartbeats h
    WHERE h.job_name = 'verify-catch-all'
  ) agg
  LEFT JOIN LATERAL (
    SELECT h.ran_at, h.detail
      FROM public.cron_heartbeats h
     WHERE h.job_name = 'verify-catch-all'
       AND NOT h.ok
       AND h.ran_at > now() - interval '2 hours'  -- must equal the FILTER window above
     ORDER BY h.ran_at DESC, h.id DESC
     LIMIT 1
  ) fail ON true;


-- ──────────────────────────────────────────────────────────────────────────────
-- MON-021: synthesis-batch-sweep. Heartbeat freshness, heartbeat failure, and
-- the batch/entry conditions. Only the recent_failure DETAIL branch changes.
-- ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.mon_021 AS
  WITH hb AS (
    SELECT
      max(h.ran_at) AS last_run,
      bool_or(NOT h.ok) FILTER (WHERE h.ran_at > now() - interval '1 hour') AS recent_failure
    FROM public.cron_heartbeats h
    WHERE h.job_name = 'synthesis-batch-sweep'
  ), hb_fail AS (
    SELECT h.ran_at, h.detail
      FROM public.cron_heartbeats h
     WHERE h.job_name = 'synthesis-batch-sweep'
       AND NOT h.ok
       AND h.ran_at > now() - interval '1 hour'   -- must equal the FILTER window above
     ORDER BY h.ran_at DESC, h.id DESC
     LIMIT 1
  ), batches AS (
    SELECT
      count(*) FILTER (WHERE b.state = 'attempted' AND b.requested_at < now() - interval '30 minutes') AS unreceipted,
      count(*) FILTER (WHERE b.state = ANY (ARRAY['submitted','ended']) AND b.requested_at < now() - interval '26 hours') AS overdue,
      max(EXTRACT(EPOCH FROM (now() - b.requested_at)) / 3600)
        FILTER (WHERE b.state = ANY (ARRAY['attempted','submitted','ended'])) AS oldest_open_hours
    FROM public.synthesis_batches b
  ), entries AS (
    SELECT
      count(*) FILTER (WHERE e.state = 'pending_submission' AND e.created_at < now() - interval '30 minutes') AS stuck_pending,
      count(*) FILTER (WHERE e.state = ANY (ARRAY['succeeded','collected']) AND e.updated_at > now() - interval '24 hours') AS good_24h,
      count(*) FILTER (WHERE e.state = ANY (ARRAY['errored','expired','cancelled','failed']) AND e.updated_at > now() - interval '24 hours') AS bad_24h,
      count(*) FILTER (WHERE e.doc_superseded AND e.updated_at > now() - interval '24 hours') AS superseded_24h
    FROM public.synthesis_batch_entries e
  )
  SELECT
    'MON-021'::text AS check_code,
    CASE
      WHEN hb.last_run IS NULL THEN 'UNKNOWN'
      WHEN EXTRACT(EPOCH FROM (now() - hb.last_run)) / 60 > 15 THEN 'PROBLEM'
      WHEN hb.recent_failure THEN 'PROBLEM'
      WHEN batches.unreceipted > 0 THEN 'PROBLEM'
      WHEN batches.overdue > 0 THEN 'PROBLEM'
      WHEN entries.stuck_pending > 0 THEN 'PROBLEM'
      WHEN (entries.good_24h + entries.bad_24h) >= 5
        AND (entries.bad_24h::numeric / (entries.good_24h + entries.bad_24h)::numeric) > 0.20 THEN 'PROBLEM'
      ELSE 'OK'
    END AS state,
    CASE
      WHEN hb.last_run IS NULL
        THEN 'The synthesis batch sweep has never run. Expected until its pg_cron job is scheduled.'
      WHEN EXTRACT(EPOCH FROM (now() - hb.last_run)) / 60 > 15
        THEN 'Sweep last ran ' || TO_CHAR(hb.last_run, 'YYYY-MM-DD HH24:MI:SS UTC') || ', over 15 minutes ago.'
      WHEN hb.recent_failure
        THEN 'Run at ' || TO_CHAR(hb_fail.ran_at, 'YYYY-MM-DD HH24:MI:SS UTC')
             || ' FAILED: ' || COALESCE(hb_fail.detail, 'no detail')
      WHEN batches.unreceipted > 0
        THEN batches.unreceipted || ' batch(es) submitted with no receipt recorded for over 30 minutes. '
             || 'Reconciliation should have attached them. This is the state that can lead to paying twice.'
      WHEN batches.overdue > 0
        THEN batches.overdue || ' batch(es) still open past 26 hours, so the sweep is not ageing them out. '
             || 'Oldest open batch: ' || round(COALESCE(batches.oldest_open_hours, 0), 1) || 'h.'
      WHEN entries.stuck_pending > 0
        THEN entries.stuck_pending || ' entr(ies) have waited over 30 minutes to be submitted. '
             || 'Their sources are already paid for.'
      WHEN (entries.good_24h + entries.bad_24h) >= 5
        AND (entries.bad_24h::numeric / (entries.good_24h + entries.bad_24h)::numeric) > 0.20
        THEN entries.bad_24h || ' of ' || (entries.good_24h + entries.bad_24h)
             || ' synthesis entries failed in the last 24h.'
      ELSE 'Sweep last ran ' || TO_CHAR(hb.last_run, 'YYYY-MM-DD HH24:MI:SS UTC')
           || '. Open batches oldest ' || round(COALESCE(batches.oldest_open_hours, 0), 1) || 'h. '
           || 'Last 24h: ' || entries.good_24h || ' collected, ' || entries.bad_24h || ' failed, '
           || entries.superseded_24h || ' written against a superseded messaging document.'
    END AS detail,
    hb.last_run
  FROM hb
  LEFT JOIN hb_fail ON true
  CROSS JOIN batches
  CROSS JOIN entries;
