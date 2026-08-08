-- Add five Tier 1 detection checks: MON-011 through MON-015
-- These are signal-based checks (not liveness). Each has a corresponding SQL view.

-- Insert the five new checks into monitor_checks
INSERT INTO public.monitor_checks (code, title, description, category, tier, is_scheduled, expected_interval_minutes)
VALUES
  ('MON-011', 'Unresolved failed agent runs', 'Detects agent runs that failed and remain unresolved (last 7 days)', 'tier1', 1, false, null),
  ('MON-012', 'Zombie agent runs', 'Detects agent runs still marked running after 15 minutes (potential reaper failure)', 'tier1', 1, false, null),
  ('MON-013', 'Orphaned campaigns', 'Detects campaigns with sync attempted but no external_id assigned', 'tier1', 1, false, null),
  ('MON-014', 'Stale unprocessed signals', 'Detects signals not yet processed, older than 48 hours', 'tier1', 1, false, null),
  ('MON-015', 'Permanently failed replies', 'Detects reply handling actions marked permanently_failed (last 7 days)', 'tier1', 1, false, null)
ON CONFLICT (code) DO NOTHING;

-- ──────────────────────────────────────────────────────────────────────────────
-- VIEW: mon_011 (Unresolved failed agent runs)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.mon_011 AS
  WITH failed_runs AS (
    SELECT COUNT(*) as count, MAX(completed_at) as newest
    FROM public.agent_runs
    WHERE status = 'failed'
      AND completed_at >= (now() - interval '7 days')
  )
  SELECT
    'MON-011'::text as check_code,
    CASE
      WHEN count = 0 THEN 'OK'
      ELSE 'PROBLEM'
    END as state,
    CASE
      WHEN count = 0 THEN 'No unresolved failed agent runs'
      ELSE count::text || ' failed agent run(s) in last 7 days. Newest: ' ||
           TO_CHAR(newest, 'YYYY-MM-DD HH24:MI:SS UTC')
    END as detail,
    newest as oldest_incident
  FROM failed_runs;

-- ──────────────────────────────────────────────────────────────────────────────
-- VIEW: mon_012 (Zombie agent runs)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.mon_012 AS
  WITH zombies AS (
    SELECT COUNT(*) as count, MAX(started_at) as oldest_started
    FROM public.agent_runs
    WHERE status = 'running'
      AND started_at < (now() - interval '15 minutes')
  )
  SELECT
    'MON-012'::text as check_code,
    CASE
      WHEN count = 0 THEN 'OK'
      ELSE 'PROBLEM'
    END as state,
    CASE
      WHEN count = 0 THEN 'No zombie agent runs detected'
      ELSE count::text || ' zombie run(s) running for >15min. Oldest started: ' ||
           TO_CHAR(oldest_started, 'YYYY-MM-DD HH24:MI:SS UTC')
    END as detail,
    oldest_started as oldest_zombie
  FROM zombies;

-- ──────────────────────────────────────────────────────────────────────────────
-- VIEW: mon_013 (Orphaned campaigns)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.mon_013 AS
  WITH orphaned AS (
    SELECT COUNT(*) as count
    FROM public.campaigns
    WHERE status = 'active'
      AND external_id IS NULL
  )
  SELECT
    'MON-013'::text as check_code,
    CASE
      WHEN count = 0 THEN 'OK'
      ELSE 'PROBLEM'
    END as state,
    CASE
      WHEN count = 0 THEN 'No orphaned active campaigns'
      ELSE count::text || ' active campaign(s) with no external_id (sync incomplete)'
    END as detail,
    now() as check_time
  FROM orphaned;

-- ──────────────────────────────────────────────────────────────────────────────
-- VIEW: mon_014 (Stale unprocessed signals)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.mon_014 AS
  WITH stale AS (
    SELECT COUNT(*) as count, MIN(created_at) as oldest
    FROM public.signals
    WHERE processed = false
      AND created_at < (now() - interval '48 hours')
  )
  SELECT
    'MON-014'::text as check_code,
    CASE
      WHEN count = 0 THEN 'OK'
      ELSE 'PROBLEM'
    END as state,
    CASE
      WHEN count = 0 THEN 'No stale unprocessed signals'
      ELSE count::text || ' signal(s) unprocessed for >48h. Oldest: ' ||
           TO_CHAR(oldest, 'YYYY-MM-DD HH24:MI:SS UTC')
    END as detail,
    oldest as oldest_signal
  FROM stale;

-- ──────────────────────────────────────────────────────────────────────────────
-- VIEW: mon_015 (Permanently failed replies)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.mon_015 AS
  WITH failed_actions AS (
    SELECT COUNT(*) as count, MAX(created_at) as newest
    FROM public.reply_handling_actions
    WHERE action_taken = 'permanently_failed'
      AND created_at >= (now() - interval '7 days')
  )
  SELECT
    'MON-015'::text as check_code,
    CASE
      WHEN count = 0 THEN 'OK'
      ELSE 'PROBLEM'
    END as state,
    CASE
      WHEN count = 0 THEN 'No permanently failed reply actions in last 7 days'
      ELSE count::text || ' reply action(s) marked permanently_failed. Newest: ' ||
           TO_CHAR(newest, 'YYYY-MM-DD HH24:MI:SS UTC')
    END as detail,
    newest as newest_failure
  FROM failed_actions;
