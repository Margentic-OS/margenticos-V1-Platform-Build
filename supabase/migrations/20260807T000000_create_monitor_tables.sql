-- Migration: Create monitor infrastructure tables and views
-- Includes cron_heartbeats (liveness), monitor_checks (registry),
-- monitor_events (alert state), and views for each approved check.
-- All with RLS and service_role-only access.

-- ──────────────────────────────────────────────────────────────────────────────
-- TABLE: cron_heartbeats
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cron_heartbeats (
  id bigserial PRIMARY KEY,
  job_name text NOT NULL,
  ran_at timestamptz NOT NULL DEFAULT now(),
  ok boolean NOT NULL DEFAULT true,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.cron_heartbeats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cron_heartbeats_operator_read" ON public.cron_heartbeats
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE users.id = auth.uid()
        AND users.role = 'operator'
    )
  );

REVOKE ALL ON public.cron_heartbeats FROM PUBLIC, authenticated;
GRANT SELECT ON public.cron_heartbeats TO service_role;

-- ──────────────────────────────────────────────────────────────────────────────
-- TABLE: monitor_checks (registry of all monitored checks)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.monitor_checks (
  code text PRIMARY KEY,
  title text NOT NULL,
  description text NOT NULL,
  category text NOT NULL,
  tier integer NOT NULL,
  is_scheduled boolean NOT NULL DEFAULT false,
  expected_interval_minutes integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.monitor_checks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "monitor_checks_operator_read" ON public.monitor_checks
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE users.id = auth.uid()
        AND users.role = 'operator'
    )
  );

REVOKE ALL ON public.monitor_checks FROM PUBLIC, authenticated;
GRANT SELECT ON public.monitor_checks TO service_role;
GRANT INSERT, UPDATE, DELETE ON public.monitor_checks TO service_role;

-- ──────────────────────────────────────────────────────────────────────────────
-- TABLE: monitor_events (alert state transitions)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.monitor_events (
  id bigserial PRIMARY KEY,
  check_code text NOT NULL REFERENCES public.monitor_checks(code),
  state text NOT NULL CHECK (state IN ('PROBLEM', 'OK', 'UNKNOWN')),
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

ALTER TABLE public.monitor_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "monitor_events_operator_read" ON public.monitor_events
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE users.id = auth.uid()
        AND users.role = 'operator'
    )
  );

REVOKE ALL ON public.monitor_events FROM PUBLIC, authenticated;
GRANT SELECT ON public.monitor_events TO service_role;
GRANT INSERT, UPDATE ON public.monitor_events TO service_role;

-- ──────────────────────────────────────────────────────────────────────────────
-- Seed monitor_checks registry
-- ──────────────────────────────────────────────────────────────────────────────
INSERT INTO public.monitor_checks (code, title, description, category, tier, is_scheduled, expected_interval_minutes)
VALUES
  ('MON-001', 'Auto-approve hourly', 'Hourly cron job processes due suggestions', 'liveness', 1, true, 60),
  ('MON-002', 'Instantly polling every 15m', 'Polls Instantly API for reply state', 'liveness', 1, true, 15),
  ('MON-003', 'Process replies every 5m', 'Processes new replies from Instantly', 'liveness', 1, true, 5),
  ('MON-004', 'Reap agent runs every 10m', 'Marks zombie agent runs as failed', 'liveness', 1, true, 10),
  ('MON-005', 'Monitor sweep every 15m', 'Detects liveness failures and blind spots', 'liveness', 1, true, 15),
  ('MON-006', 'Client revisions awaiting review', 'Detects client revisions older than approval window', 'tier1', 1, false, null),
  ('MON-007-UNSCHEDULED', 'Strategy doc auto-approve (UNSCHEDULED)', 'Would auto-promote strategy docs. Not yet scheduled.', 'unscheduled', 1, false, null),
  ('MON-008-UNSCHEDULED', 'Intake nudge (UNSCHEDULED)', 'Would nudge incomplete intakes. Not yet scheduled.', 'unscheduled', 1, false, null),
  ('MON-009-UNSCHEDULED', 'Warmup halfway (UNSCHEDULED)', 'Would trigger warmup cascade at 50%. Not yet scheduled.', 'unscheduled', 1, false, null),
  ('MON-010-UNSCHEDULED', 'Resolve auto-held (UNSCHEDULED)', 'Would auto-resolve long-held escalations. Not yet scheduled.', 'unscheduled', 1, false, null)
ON CONFLICT (code) DO NOTHING;

-- ──────────────────────────────────────────────────────────────────────────────
-- VIEW: mon_001 (Auto-approve hourly liveness)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.mon_001 AS
  SELECT
    'MON-001'::text as check_code,
    CASE
      WHEN MAX(ran_at) IS NULL THEN 'UNKNOWN'
      WHEN EXTRACT(EPOCH FROM (now() - MAX(ran_at))) / 60 > 75 THEN 'PROBLEM'
      ELSE 'OK'
    END as state,
    COALESCE(
      MAX(CASE WHEN ok = false THEN detail END),
      'Last run: ' || TO_CHAR(MAX(ran_at), 'YYYY-MM-DD HH24:MI:SS UTC')
    ) as detail,
    MAX(ran_at) as last_run
  FROM public.cron_heartbeats
  WHERE job_name = 'auto-approve';

-- ──────────────────────────────────────────────────────────────────────────────
-- VIEW: mon_002 (Instantly polling every 15m liveness)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.mon_002 AS
  SELECT
    'MON-002'::text as check_code,
    CASE
      WHEN MAX(ran_at) IS NULL THEN 'UNKNOWN'
      WHEN EXTRACT(EPOCH FROM (now() - MAX(ran_at))) / 60 > 30 THEN 'PROBLEM'
      ELSE 'OK'
    END as state,
    COALESCE(
      MAX(CASE WHEN ok = false THEN detail END),
      'Last run: ' || TO_CHAR(MAX(ran_at), 'YYYY-MM-DD HH24:MI:SS UTC')
    ) as detail,
    MAX(ran_at) as last_run
  FROM public.cron_heartbeats
  WHERE job_name = 'instantly-poll';

-- ──────────────────────────────────────────────────────────────────────────────
-- VIEW: mon_003 (Process replies every 5m liveness)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.mon_003 AS
  SELECT
    'MON-003'::text as check_code,
    CASE
      WHEN MAX(ran_at) IS NULL THEN 'UNKNOWN'
      WHEN EXTRACT(EPOCH FROM (now() - MAX(ran_at))) / 60 > 10 THEN 'PROBLEM'
      ELSE 'OK'
    END as state,
    COALESCE(
      MAX(CASE WHEN ok = false THEN detail END),
      'Last run: ' || TO_CHAR(MAX(ran_at), 'YYYY-MM-DD HH24:MI:SS UTC')
    ) as detail,
    MAX(ran_at) as last_run
  FROM public.cron_heartbeats
  WHERE job_name = 'process-replies';

-- ──────────────────────────────────────────────────────────────────────────────
-- VIEW: mon_004 (Reap agent runs every 10m liveness)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.mon_004 AS
  SELECT
    'MON-004'::text as check_code,
    CASE
      WHEN MAX(ran_at) IS NULL THEN 'UNKNOWN'
      WHEN EXTRACT(EPOCH FROM (now() - MAX(ran_at))) / 60 > 20 THEN 'PROBLEM'
      ELSE 'OK'
    END as state,
    COALESCE(
      MAX(CASE WHEN ok = false THEN detail END),
      'Last run: ' || TO_CHAR(MAX(ran_at), 'YYYY-MM-DD HH24:MI:SS UTC')
    ) as detail,
    MAX(ran_at) as last_run
  FROM public.cron_heartbeats
  WHERE job_name = 'reap-agent-runs';

-- ──────────────────────────────────────────────────────────────────────────────
-- VIEW: mon_005 (Monitor sweep every 15m liveness)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.mon_005 AS
  SELECT
    'MON-005'::text as check_code,
    CASE
      WHEN MAX(ran_at) IS NULL THEN 'UNKNOWN'
      WHEN EXTRACT(EPOCH FROM (now() - MAX(ran_at))) / 60 > 30 THEN 'PROBLEM'
      ELSE 'OK'
    END as state,
    COALESCE(
      MAX(CASE WHEN ok = false THEN detail END),
      'Last run: ' || TO_CHAR(MAX(ran_at), 'YYYY-MM-DD HH24:MI:SS UTC')
    ) as detail,
    MAX(ran_at) as last_run
  FROM public.cron_heartbeats
  WHERE job_name = 'monitor-sweep';

-- ──────────────────────────────────────────────────────────────────────────────
-- VIEW: mon_006 (Client revisions awaiting review)
-- Uses explicit equality for future-safety if column becomes nullable.
-- ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.mon_006 AS
  WITH stats AS (
    SELECT
      COUNT(*) as revision_count,
      MAX(ds.created_at) as oldest_created,
      COALESCE((
        SELECT auto_approve_window_hours FROM public.organisations
        WHERE id = (SELECT DISTINCT organisation_id FROM public.document_suggestions
                   WHERE status = 'pending' AND update_trigger = 'client_revision' LIMIT 1)
      ), 72) as window_hours,
      MAX(EXTRACT(EPOCH FROM (now() - ds.created_at)) / 60 / 60) as oldest_age_hours
    FROM public.document_suggestions ds
    WHERE ds.status = 'pending'
      AND ds.update_trigger = 'client_revision'
  )
  SELECT
    'MON-006'::text as check_code,
    CASE
      WHEN revision_count = 0 THEN 'OK'
      WHEN oldest_age_hours > window_hours THEN 'PROBLEM'
      ELSE 'OK'
    END as state,
    CASE
      WHEN revision_count = 0 THEN 'No client revisions pending'
      ELSE revision_count::text || ' client revision(s) awaiting review. Oldest: ' ||
           TO_CHAR(oldest_created, 'YYYY-MM-DD HH24:MI:SS UTC')
    END as detail,
    oldest_created as oldest_revision
  FROM stats;

-- ──────────────────────────────────────────────────────────────────────────────
-- Indexes for performance
-- ──────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_cron_heartbeats_job_name
  ON public.cron_heartbeats(job_name, ran_at DESC);

CREATE INDEX IF NOT EXISTS idx_monitor_events_check_code_created
  ON public.monitor_events(check_code, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_document_suggestions_status_update_trigger
  ON public.document_suggestions(status, update_trigger)
  WHERE status = 'pending';
