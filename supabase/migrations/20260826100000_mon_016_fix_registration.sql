-- MON-016: the registration says one thing and the view checks another.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT IS WRONG
--
-- 20260824180000_queue_monitoring.sql created the mon_016 VIEW as queue-worker health, and
-- seeded its monitor_checks row with ON CONFLICT (code) DO NOTHING (that file, line 236).
-- A row with code MON-016 already existed, so the seed silently lost and the metadata never
-- landed. Live, before this migration:
--
--   code     | title                        | category | tier | interval
--   MON-016  | Prospects stuck at uploading | delivery | 2    | 60
--
-- while public.mon_016 reads cron_heartbeats WHERE job_name = 'queue-worker'.
--
-- THE CONSEQUENCE IS NOT COSMETIC. The dashboard's Active Problems panel renders title,
-- plain_meaning, plain_impact and plain_action straight from this row. So when the QUEUE
-- WORKER dies, the view correctly goes PROBLEM and the operator is told "Prospects stuck at
-- uploading" and instructed to "manually reset stuck prospects by updating
-- outbound_upload_status back to pending" — an action that is unrelated to the failure and
-- fixes nothing, while the actual cause goes unnamed.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY AN UPSERT AND NOT A BARE UPDATE
--
-- The losing row is NOT IN THIS REPOSITORY. No migration here creates a MON-016 titled
-- "Prospects stuck at uploading"; the repo's monitor_checks seeds stop at MON-015 before the
-- queue migration, and `git log --all -S "stuck at uploading"` finds only the MON-019
-- migration's comment asserting this bug. It was applied out of band.
--
-- So a database rebuilt from migrations alone does NOT reproduce the drift, and an UPDATE
-- would be a silent no-op there while the row stayed missing. An upsert is correct in both
-- worlds: it inserts on a clean rebuild and corrects the drifted row live.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- THE CATEGORY CHANGE IS DELIBERATE AND DOES TWO JOBS
--
-- delivery -> liveness. It is what the check actually is, and it is also the only category
-- of the three the dashboard renders as a standing section that fits. Without it, MON-016
-- appears only in Active Problems when it is already failing, and never in the steady-state
-- list where an operator would look to confirm the worker is alive.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- NOTHING IS LOST BY REPLACING THE OLD MEANING
--
-- Checked before writing this: monitor_events holds exactly ONE MON-016 row ever, state OK
-- at 2026-08-24 23:00:02, which POST-DATES the queue migration. So the old "stuck at
-- uploading" check never produced a single event under this code, and the view that would
-- have implemented it was replaced by CREATE OR REPLACE two days ago. Only the metadata row
-- survived, pointing at a check that no longer exists.
--
-- Status: APPLIED (verified live 2026-08-26)
--
-- Read-back immediately after apply:
--   code    | title               | category | tier | is_scheduled | expected_interval_minutes
--   MON-016 | Queue worker health | liveness | 1    | t            | 1
--
-- Against, immediately before:
--   MON-016 | Prospects stuck at uploading | delivery | 2 | t | 60

INSERT INTO public.monitor_checks
  (code, title, description, category, tier, is_scheduled, expected_interval_minutes,
   plain_meaning, plain_impact, plain_action)
VALUES (
  'MON-016',
  'Queue worker health',
  'The queue worker is running on schedule AND its last run reported success.',
  'liveness',
  1,
  true,
  1,
  'The background worker that runs enrichment, research and composition jobs either '
    || 'stopped running, or ran and reported a problem.',
  'Queued work is not being picked up. Nothing is lost, but nothing progresses until this '
    || 'is fixed.',
  'Check the queue-worker heartbeat detail for the reason: SELECT ran_at, ok, detail FROM '
    || 'cron_heartbeats WHERE job_name = ''queue-worker'' ORDER BY ran_at DESC LIMIT 5. '
    || 'If the last run is stale rather than failed, check the pg_cron job is still active: '
    || 'SELECT jobname, active FROM cron.job WHERE jobname = ''queue-worker''.'
)
ON CONFLICT (code) DO UPDATE SET
  title                     = EXCLUDED.title,
  description               = EXCLUDED.description,
  category                  = EXCLUDED.category,
  tier                      = EXCLUDED.tier,
  is_scheduled              = EXCLUDED.is_scheduled,
  expected_interval_minutes = EXCLUDED.expected_interval_minutes,
  plain_meaning             = EXCLUDED.plain_meaning,
  plain_impact              = EXCLUDED.plain_impact,
  plain_action              = EXCLUDED.plain_action;

-- ═════════════════════════════════════════════════════════════════════════════
-- THE GENERAL RULE, since this is the second time DO NOTHING has cost something.
--
-- A monitor_checks seed must use ON CONFLICT (code) DO UPDATE, never DO NOTHING. DO NOTHING
-- means "whatever is already there wins", which for a seed is not idempotence, it is a coin
-- toss decided by history nobody can see.
--
-- Three seeds in this repo still use DO NOTHING: 20260807T000000_create_monitor_tables.sql
-- (MON-001..MON-010), 20260807_add_detection_checks.sql (MON-011..MON-015), and the queue
-- one. All 20 live rows were diffed against those seeds while writing this: MON-016 is the
-- only code that actually drifted. MON-007 and MON-010 differ from their seed too, but by
-- deliberate later UPDATE migrations, which is intended. The rest are latent exposure, not
-- active bugs, and are left alone rather than rewritten speculatively. See docs/BACKLOG.md.
