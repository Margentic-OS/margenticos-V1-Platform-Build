-- Complete liveness integration for MON-007 and MON-010.
--
-- These checks were marked as liveness category but with incomplete integration:
--   - Codes had (UNSCHEDULED) suffix
--   - Titles and copy said "not yet scheduled"
--   - No views existed to query cron_heartbeats
--
-- This migration:
--   1. Updates codes from MON-007-UNSCHEDULED → MON-007, MON-010-UNSCHEDULED → MON-010
--   2. Updates all affected rows in monitor_checks and monitor_events consistently
--   3. Rewrites plain_meaning, plain_impact, plain_action for scheduled jobs
--   4. Creates views mon_007 and mon_010 to evaluate cron_heartbeats
--   5. Note: monitor-sweep route.ts must be updated separately to include MON-007, MON-010 in check list

-- ── Update monitor_checks ──────────────────────────────────────────────────────

UPDATE monitor_checks
SET
  code = 'MON-007',
  title = 'Strategy doc auto-approve daily',
  description = 'Auto-approves strategy documents whose 3-day review window has elapsed.',
  plain_meaning = 'Runs daily at 06:00 UTC via pg_cron to auto-promote strategy_documents with status=pending and age >= 3 days. Monitors success via cron_heartbeats.',
  plain_impact = 'If this check fails: pending strategy documents will not auto-approve, remaining in review queue indefinitely. Clients see outdated strategy docs in their drafts.',
  plain_action = 'Verify the cron job is running and the database connection is healthy. Check Sentry for errors in the approval function.'
WHERE code = 'MON-007-UNSCHEDULED';

UPDATE monitor_checks
SET
  code = 'MON-010',
  title = 'Resolve auto-held daily',
  description = 'Auto-resolves escalations past their hold window.',
  plain_meaning = 'Runs daily at 09:00 UTC via pg_cron to auto-resolve escalated meetings that have exceeded their hold duration. Monitors success via cron_heartbeats.',
  plain_impact = 'If this check fails: escalated meetings remain stuck in held status, blocking the information-request workflow and delaying client resolution.',
  plain_action = 'Verify the cron job is running and the database connection is healthy. Check Sentry for errors in the resolution function.'
WHERE code = 'MON-010-UNSCHEDULED';

-- ── Update monitor_events to match new codes ───────────────────────────────────

UPDATE monitor_events
SET check_code = 'MON-007'
WHERE check_code = 'MON-007-UNSCHEDULED';

UPDATE monitor_events
SET check_code = 'MON-010'
WHERE check_code = 'MON-010-UNSCHEDULED';

-- ── Create view mon_007 ────────────────────────────────────────────────────────
-- Evaluates the strategy-doc-auto-approve job.
-- Threshold: 90 minutes (1440 min interval + 75 min buffer for clock skew / processing)

CREATE OR REPLACE VIEW mon_007 AS
SELECT
  'MON-007'::text AS check_code,
  CASE
    WHEN max(ran_at) IS NULL THEN 'UNKNOWN'::text
    WHEN (EXTRACT(epoch FROM (now() - max(ran_at))) / 60::numeric) > 90::numeric THEN 'PROBLEM'::text
    ELSE 'OK'::text
  END AS state,
  COALESCE(
    max(CASE WHEN ok = false THEN detail ELSE NULL::text END),
    ('Last run: '::text || to_char(max(ran_at), 'YYYY-MM-DD HH24:MI:SS UTC'::text))
  ) AS detail,
  max(ran_at) AS last_run
FROM cron_heartbeats
WHERE job_name = 'strategy-doc-auto-approve'::text;

-- ── Create view mon_010 ────────────────────────────────────────────────────────
-- Evaluates the resolve-auto-held job.
-- Threshold: 90 minutes (1440 min interval + 75 min buffer for clock skew / processing)

CREATE OR REPLACE VIEW mon_010 AS
SELECT
  'MON-010'::text AS check_code,
  CASE
    WHEN max(ran_at) IS NULL THEN 'UNKNOWN'::text
    WHEN (EXTRACT(epoch FROM (now() - max(ran_at))) / 60::numeric) > 90::numeric THEN 'PROBLEM'::text
    ELSE 'OK'::text
  END AS state,
  COALESCE(
    max(CASE WHEN ok = false THEN detail ELSE NULL::text END),
    ('Last run: '::text || to_char(max(ran_at), 'YYYY-MM-DD HH24:MI:SS UTC'::text))
  ) AS detail,
  max(ran_at) AS last_run
FROM cron_heartbeats
WHERE job_name = 'resolve-auto-held'::text;

-- ── Commit message ─────────────────────────────────────────────────────────────
-- Complete liveness integration for MON-007 and MON-010.
-- Removed (UNSCHEDULED) codes and tags. Updated copy to describe actual daily schedules.
-- Created mon_007 and mon_010 views to query cron_heartbeats. Sweep route.ts must add these to check lists.
