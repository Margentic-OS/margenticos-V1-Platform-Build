-- Migration: queue depth view, three queue monitors, and the worker cron schedule
-- Date: 2026-08-24
--
-- Status: PENDING (apply via Supabase MCP apply_migration, then verify live)
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT THIS DOES NOT INHERIT FROM MON-002
--
-- MON-002 derives its state from max(ran_at) staleness ALONE:
--
--     WHEN (EXTRACT(epoch FROM now() - max(ran_at)) / 60) > 30 THEN 'PROBLEM' ELSE 'OK'
--
-- cron_heartbeats.ok is read only to populate the detail STRING, never the state. So a
-- cron that runs punctually every fifteen minutes and fails every single time reads OK.
-- It answers "is the cron running", not "is the cron working", and two earlier BACKLOG
-- entries claimed otherwise for months.
--
-- The three monitors below answer the second question. MON-016 reads ok as well as
-- staleness. MON-017 and MON-018 ignore the heartbeat entirely and read the queue's real
-- contents, because "the worker ran" and "work is getting done" are different facts and
-- the failure that matters is a worker that ticks happily while the queue never drains.

-- ═════════════════════════════════════════════════════════════════════════════
-- QUEUE DEPTH, QUERYABLE
--
-- Depth and the age of the oldest queued job, per job type and organisation. Read by
-- MON-016 and available for ad-hoc operator queries, which is the "both queryable"
-- requirement.

CREATE OR REPLACE VIEW public.queue_depth AS
SELECT
  q.job_type,
  q.organisation_id,
  count(*) FILTER (WHERE q.state = 'queued')                                   AS queued,
  count(*) FILTER (WHERE q.state = 'claimed')                                  AS claimed,
  count(*) FILTER (WHERE q.state = 'failed')                                   AS failed_total,
  count(*) FILTER (WHERE q.state = 'done'   AND q.updated_at > now() - interval '24 hours') AS done_24h,
  count(*) FILTER (WHERE q.state = 'failed' AND q.updated_at > now() - interval '24 hours') AS failed_24h,
  -- Age of the oldest job that is ELIGIBLE to run. run_after <= now() excludes jobs
  -- sitting in backoff: a job deliberately waiting out its retry delay is not a backlog
  -- symptom, and counting it would make every transient failure look like a stall.
  COALESCE(
    EXTRACT(epoch FROM now() - min(q.created_at)
      FILTER (WHERE q.state = 'queued' AND q.run_after <= now()))::bigint,
    0
  )                                                                            AS oldest_queued_age_seconds,
  max(q.updated_at) FILTER (WHERE q.state = 'done')                            AS last_completion_at
FROM public.job_queue q
GROUP BY q.job_type, q.organisation_id;

-- ═════════════════════════════════════════════════════════════════════════════
-- MON-016 — worker liveness AND outcome
--
-- Unlike MON-002 this is PROBLEM when the last run reported ok = false, not only when
-- the runs stopped arriving. Both failure modes are real and they are different:
--
--   stale heartbeat  the cron stopped firing, or the route is erroring before it can
--                    write. Nothing is being claimed at all.
--   ok = false       the worker is running on time and something inside it failed: a
--                    job type enabled with no handler, a reclaim failure, a tripped
--                    circuit breaker, or a breaker that could not fire.
--
-- 5 minutes of staleness against a one-minute schedule. Generous enough to absorb a
-- couple of missed ticks without flapping, tight enough that a stopped worker is noticed
-- inside the same working session.

CREATE OR REPLACE VIEW public.mon_016 AS
WITH latest AS (
  SELECT ok, detail, ran_at
    FROM public.cron_heartbeats
   WHERE job_name = 'queue-worker'
   ORDER BY ran_at DESC
   LIMIT 1
)
SELECT
  'MON-016'::text AS check_code,
  CASE
    WHEN (SELECT count(*) FROM latest) = 0 THEN 'UNKNOWN'
    WHEN (SELECT EXTRACT(epoch FROM now() - ran_at) / 60 FROM latest) > 5 THEN 'PROBLEM'
    -- The clause MON-002 does not have.
    WHEN (SELECT ok FROM latest) = false THEN 'PROBLEM'
    ELSE 'OK'
  END AS state,
  CASE
    WHEN (SELECT count(*) FROM latest) = 0
      THEN 'Queue worker has never reported. Check the pg_cron job queue-worker exists and is active.'
    WHEN (SELECT EXTRACT(epoch FROM now() - ran_at) / 60 FROM latest) > 5
      THEN 'Queue worker last ran '
           || to_char((SELECT ran_at FROM latest), 'YYYY-MM-DD HH24:MI:SS UTC')
           || ', over 5 minutes ago against a one-minute schedule.'
    WHEN (SELECT ok FROM latest) = false
      THEN 'Queue worker ran but reported failure: ' || COALESCE((SELECT detail FROM latest), 'no detail')
    ELSE 'Last run OK: ' || COALESCE((SELECT detail FROM latest), '')
  END AS detail,
  (SELECT ran_at FROM latest) AS last_run;

-- ═════════════════════════════════════════════════════════════════════════════
-- MON-017 — the stall alarm
--
-- PROBLEM when jobs are queued and eligible, and NOTHING has completed in 60 minutes.
--
-- This is the check that catches the failure MON-002 cannot see: a worker ticking
-- happily every minute while the queue never drains. It reads the queue itself and never
-- looks at the heartbeat, precisely so a green heartbeat cannot mask it.
--
-- Both halves are required. Queued work with no completions is a stall. Queued work with
-- completions is a queue doing its job. NO queued work is not a stall however long it has
-- been since the last completion, because an idle queue is the normal state at this
-- stage of the build and an alarm that fires on idleness would be permanently red.
--
-- run_after <= now() excludes jobs in backoff, so a batch that all failed transiently
-- and is waiting out its delay does not read as a stall.

CREATE OR REPLACE VIEW public.mon_017 AS
WITH eligible AS (
  SELECT count(*) AS queued, min(created_at) AS oldest
    FROM public.job_queue
   WHERE state = 'queued' AND run_after <= now()
),
completions AS (
  SELECT max(updated_at) AS last_done
    FROM public.job_queue
   WHERE state = 'done'
)
SELECT
  'MON-017'::text AS check_code,
  CASE
    WHEN (SELECT queued FROM eligible) = 0 THEN 'OK'
    WHEN (SELECT last_done FROM completions) IS NULL
     AND (SELECT EXTRACT(epoch FROM now() - oldest) / 60 FROM eligible) > 60 THEN 'PROBLEM'
    WHEN (SELECT last_done FROM completions) < now() - interval '60 minutes' THEN 'PROBLEM'
    ELSE 'OK'
  END AS state,
  CASE
    WHEN (SELECT queued FROM eligible) = 0
      THEN 'No eligible queued jobs. Nothing to drain.'
    ELSE (SELECT queued FROM eligible)::text
         || ' job(s) queued and eligible, oldest waiting '
         || COALESCE((SELECT round(EXTRACT(epoch FROM now() - oldest) / 60) FROM eligible), 0)::text
         || ' minutes. Last completion: '
         || COALESCE(to_char((SELECT last_done FROM completions), 'YYYY-MM-DD HH24:MI:SS UTC'), 'never')
  END AS detail,
  (SELECT last_done FROM completions) AS last_run;

-- ═════════════════════════════════════════════════════════════════════════════
-- MON-018 — failure rate
--
-- THE THRESHOLD, and why it is not a single number.
--
-- Two independent triggers, either of which fires:
--
--   1. ABSOLUTE: 10 or more terminal failures in 24 hours.
--   2. PROPORTIONAL: failures are 10% or more of terminal jobs in 24 hours, but ONLY
--      once at least 20 terminal jobs exist in the window.
--
-- The 20-job floor is what stops the percentage rule firing on a three-job day, where
-- one failure is 33% and means nothing.
--
-- The absolute trigger exists because a percentage alone is too slack at this volume.
-- Apify's plan funds roughly 833 to 1,666 prospects a month, which is 30 to 55 jobs a
-- day, so a bare 20-failure threshold would be a 40% failure rate before anything
-- alarmed. 10 failures in a day is worth a look at every volume this platform runs at.
--
-- Terminal only. 'queued' jobs mid-retry are not failures yet; counting them would make
-- every transient blip inflate the rate and then deflate it again on success.

CREATE OR REPLACE VIEW public.mon_018 AS
WITH window_stats AS (
  SELECT
    count(*) FILTER (WHERE state = 'failed') AS failed,
    count(*) FILTER (WHERE state IN ('failed', 'done')) AS terminal
  FROM public.job_queue
  WHERE updated_at > now() - interval '24 hours'
    AND state IN ('failed', 'done')
)
SELECT
  'MON-018'::text AS check_code,
  CASE
    WHEN (SELECT failed FROM window_stats) >= 10 THEN 'PROBLEM'
    WHEN (SELECT terminal FROM window_stats) >= 20
     AND (SELECT failed FROM window_stats)::numeric
         / NULLIF((SELECT terminal FROM window_stats), 0) >= 0.10 THEN 'PROBLEM'
    ELSE 'OK'
  END AS state,
  (SELECT failed FROM window_stats)::text || ' failed of '
    || (SELECT terminal FROM window_stats)::text || ' terminal job(s) in 24h'
    || CASE
         WHEN (SELECT terminal FROM window_stats) >= 20
           THEN ' (' || round(
                  100 * (SELECT failed FROM window_stats)::numeric
                  / NULLIF((SELECT terminal FROM window_stats), 0), 1)::text || '%)'
         WHEN (SELECT terminal FROM window_stats) > 0
           THEN ' (below the 20-job floor, so the percentage rule is not applied)'
         ELSE ''
       END AS detail,
  now() AS last_run;

-- ═════════════════════════════════════════════════════════════════════════════
-- REGISTER THE CHECKS
--
-- monitor_checks is what the operator dashboard reads for titles and plain-English
-- meaning. A view with no row here renders as a bare code.

INSERT INTO public.monitor_checks (code, title, description, category, tier, is_scheduled, expected_interval_minutes, plain_meaning, plain_impact, plain_action)
VALUES
  ('MON-016',
   'Queue worker health',
   'The queue worker is running on schedule AND its last run reported success.',
   'liveness', 1, true, 1,
   'The background worker that runs enrichment, research and composition jobs either stopped running, or ran and reported a problem.',
   'Queued work is not being picked up. Nothing is lost, but nothing progresses until this is fixed.',
   'Check the queue-worker heartbeat detail for the reason. If it is stale, check the pg_cron job is still active.'),

  ('MON-017',
   'Queue is draining',
   'Jobs are queued and eligible to run, but nothing has completed in the last 60 minutes.',
   'blind-spot', 1, false, NULL,
   'Work is waiting in the queue and none of it has finished for an hour.',
   'Prospects are not being enriched, researched or composed. Client campaigns stall.',
   'Check whether the job type is enabled, whether a handler is deployed for it, and whether the provider account still has credit.'),

  ('MON-018',
   'Queue failure rate',
   'Terminal job failures in 24h: 10 or more absolute, or 10% or more once at least 20 terminal jobs exist.',
   'blind-spot', 2, false, NULL,
   'An unusual number of queue jobs are failing permanently rather than succeeding.',
   'Money may be being spent on work that does not complete, and affected prospects never get their copy.',
   'Read last_error on the failed rows in job_queue. A cluster with the same message usually means a provider or configuration problem, not bad luck.')
ON CONFLICT (code) DO NOTHING;

-- ═════════════════════════════════════════════════════════════════════════════
-- ACCESS
--
-- Views inherit nothing useful by default. Same posture as the tables they read:
-- service_role only. The monitor sweep and the operator monitor routes all use the
-- service client.

REVOKE ALL ON public.queue_depth FROM anon, authenticated;
REVOKE ALL ON public.mon_016     FROM anon, authenticated;
REVOKE ALL ON public.mon_017     FROM anon, authenticated;
REVOKE ALL ON public.mon_018     FROM anon, authenticated;

GRANT SELECT ON public.queue_depth TO service_role;
GRANT SELECT ON public.mon_016     TO service_role;
GRANT SELECT ON public.mon_017     TO service_role;
GRANT SELECT ON public.mon_018     TO service_role;
