-- Status: APPLIED (verified live 2026-09-10)
-- Stagger the pg_cron minute offsets so the jobs stop colliding.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- CORRECTION, added 2026-09-10 after this was applied. READ THIS BEFORE "WHY".
--
-- The 32x in the WHY section below is a composition artefact, not evidence that
-- jobs starting together caused the failures. The offsets are KEPT AS HARMLESS
-- HYGIENE. They are not a fix. The real cause is slow reads inside specific jobs.
--
-- Why the ratio proves nothing. Each job runs only at its own minutes, so a job that
-- fails often for its own reasons can only ever fail at those minutes. Comparing
-- failure rates by minute cannot separate the crowd from the job. Re-measured over
-- this file's own 18-hour window, the 7 failures at :00 were:
--
--   suppression-reconcile   4    ran ONLY at :00 and :30
--   monitor-sweep           2    ran ONLY at :00, :15, :30, :45
--   instantly-poll          1    ran ONLY at :00, :15, :30, :45
--
-- None of those jobs could have failed at a quiet minute, because none ran at one.
-- In the 7 days before this migration their own failure rates were 1.75% (5 of 286)
-- and 1.19% (8 of 672), against 0.04% for queue-worker.
--
-- The one unconfounded test. queue-worker was the only job running every minute, so it
-- saw busy minutes and quiet ones alike. If ten jobs starting together caused the
-- timeouts, it would fail MORE at :00. It failed less:
--
--   same 18-hour window    :00   18 runs, 0 failures    other minutes  1,062 runs, 3
--   7 days before          :00  168 runs, 0 failures    quiet minutes  8,070 runs, 2
--
-- The WHY section's own diagnosis already pointed away from start-time contention:
-- the timeouts reached "a route that was already running". A query that is slow once
-- running is not helped by changing the minute it starts. The reads named in
-- cron_heartbeats.detail are suppression-reconcile's "could not read uploaded
-- prospects", "capability registry read failed" and "global suppression check
-- failed", plus queue-worker's queue_next_organisations and reclaim_expired_jobs.
-- monitor-sweep's heartbeat names no query ("Checked N monitors, 1 error(s)"), so
-- where its time goes is not established by this data.
--
-- suppression-reconcile is the job behind MON-026, the only instrument that checks
-- whether someone who asked to be removed is still being emailed. Its timeouts are
-- not ordinary job noise.
--
-- Why the offsets stay: no job's frequency changed, all ten HTTP jobs fired healthy
-- afterwards, and reverting would be a second production change for no benefit.
--
-- THE 48-HOUR TEST UNDER "WHAT TO EXPECT" CANNOT FALSIFY ANYTHING. Do not use it.
-- Its primary criterion is the by-minute ratio collapsing, and these offsets guarantee
-- that: every failure-prone job was moved off :00, which is now empty. It reports
-- WORKED whether or not contention was ever the cause. The honest before/after is PER
-- JOB: if suppression-reconcile stays near 1.75% and monitor-sweep near 1.19%, the
-- stagger changed nothing, which is what this correction predicts.
--
-- DATABASE-EVIDENCED: cron_heartbeats on production, read 2026-09-10. Do not use
-- cron.job_run_details for this. It recorded all 18,950 runs in the prior 7 days as
-- succeeded, because it records the SQL that queued the HTTP call, not the call.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY  (SUPERSEDED: see CORRECTION above)
--
-- Measured on production over the 18 hours to 2026-09-10 13:00 UTC: 13 failures
-- across four jobs, every one of them a Gateway Timeout returned by PostgREST to a
-- route that was already running. Not Vercel timing out on pg_cron: all 13 wrote
-- their own heartbeat, which a killed function cannot do.
--
-- 7 of the 13 landed at minute :00, because ten jobs fired in the same second there.
-- Failure rate by how many jobs start together, same window:
--
--   :00                     10 jobs   181 runs    7 failures   3.87%
--   :15 / :45                5 jobs   180 runs    2 failures   1.11%
--   :30                      9 jobs   162 runs    1 failure    0.62%
--   :10/:20/:40/:50          6 jobs   432 runs    2 failures   0.46%
--   every other minute       1 job    865 runs    1 failure    0.12%
--   :05/:25/:35/:55          3 jobs   216 runs    0 failures   0.00%
--
-- 32x between the top of the hour and a minute where queue-worker runs alone, against
-- max_connections = 60. 13 failures is a small sample and :30 breaks the gradient, so
-- the middle rows are noise. The :00-versus-everything-else contrast is the signal.
--
-- This is self-inflicted scheduling, not a plan ceiling. Staggering is free and
-- reversible, so it is tried and MEASURED before anything is upgraded.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT TO EXPECT  (DO NOT USE: see CORRECTION above. This test cannot falsify.)
--
-- Re-measure after 48 hours (~5,400 runs). At the observed 0.64% overall rate an
-- unchanged system predicts ~35 failures.
--
--   WORKED       <= 14 failures AND no minute-of-hour above ~1% AND max/min ratio < 4x
--   DID NOT WORK >= 28 failures, OR any minute still above 3%
--   AMBIGUOUS    15-27; widen the window rather than concluding
--
-- The primary test is the RATIO collapsing, not the absolute count: it is robust to
-- volume changes and it is the direct test of the hypothesis.
--
-- If failures stay near 0.64% but spread EVENLY across minutes, the herd was not the
-- cause. That result argues for investigating the instance's baseline IO, and still
-- not for upgrading the plan on this evidence.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY alter_job AND NOT cron.schedule
--
-- cron.job.command carries a HARDCODED bearer token, because ALTER DATABASE ... SET
-- "app.*" needs superuser on Supabase and current_setting() returns NULL. Re-creating
-- a job with cron.schedule would mean writing that secret into this file, which the
-- pre-commit secret gate would block, and correctly. alter_job changes the schedule
-- alone and never reads or rewrites the command.
--
-- Jobs are looked up BY NAME, not by hardcoded jobid, so this is portable.
--
-- Resulting layout, at most 2 jobs per minute instead of 10. queue-worker stays at
-- every-minute: it cannot be staggered, and it is the lightest and the only one with
-- its own retry (job_queue leases). :00, :29, :39, :49 and :59 end up empty.

SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'process-replies'),        schedule => '1-59/5 * * * *');
SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'synthesis-batch-sweep'),  schedule => '3-59/5 * * * *');
SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'reap-agent-runs'),        schedule => '2-59/10 * * * *');
SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'verify-pending'),         schedule => '4-59/10 * * * *');
SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'verify-catch-all'),       schedule => '7-59/10 * * * *');
SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'monitor-sweep'),          schedule => '5-59/15 * * * *');
SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'instantly-poll'),         schedule => '10-59/15 * * * *');
SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'suppression-reconcile'),  schedule => '15-59/30 * * * *');
SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'auto-approve'),           schedule => '30 * * * *');
SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'resolve-auto-held'),      schedule => '9 9 * * *');
SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'cron-heartbeats-retention'), schedule => '19 3 * * *');

-- queue-worker deliberately unchanged at '* * * * *'.
