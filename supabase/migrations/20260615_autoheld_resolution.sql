-- Auto-held resolution: Postgres function to resolve meetings past their confirmation window
-- Window is measured from scheduled_start_at (not booked_at), per CORRECTION 1
-- Formula: scheduled_start_at + (organisations.auto_held_window_hours) < now()
-- Exclusions: canceled, rescheduled meetings; already-locked meetings

-- ── 1. Function: resolve_autoheld_meetings ─────────────────────────────────

CREATE OR REPLACE FUNCTION resolve_autoheld_meetings()
RETURNS TABLE(resolved_count integer, org_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_org_id uuid;
  v_window_hours integer;
  v_resolved integer := 0;
BEGIN
  -- Loop through each organisation
  FOR v_org_id, v_window_hours IN
    SELECT id, auto_held_window_hours FROM organisations
  LOOP
    -- Update eligible meetings to auto-held
    UPDATE meetings
    SET
      meeting_status = 'held',
      held_confirmed_by = 'auto',
      held_decision_locked = true,
      is_billable = true,
      updated_at = now()
    WHERE
      organisation_id = v_org_id
      AND meeting_status = 'booked'
      AND held_decision_locked = false
      AND scheduled_start_at IS NOT NULL
      AND scheduled_start_at + (v_window_hours || ' hours')::interval < now()
    ;

    GET DIAGNOSTICS v_resolved = ROW_COUNT;

    IF v_resolved > 0 THEN
      INSERT INTO signals (
        organisation_id,
        signal_type,
        prospect_id,
        raw_data,
        processed,
        created_at
      )
      SELECT
        organisation_id,
        'meeting_auto_held',
        prospect_id,
        jsonb_build_object(
          'meeting_id', id,
          'resolved_at', now(),
          'scheduled_start_at', scheduled_start_at,
          'window_hours', v_window_hours
        ),
        true,
        now()
      FROM meetings
      WHERE
        organisation_id = v_org_id
        AND meeting_status = 'held'
        AND held_confirmed_by = 'auto'
        AND updated_at = now()
      ;
    END IF;
  END LOOP;

  RETURN QUERY SELECT 0::integer, NULL::uuid; -- Placeholder; see loop above for row tracking
END;
$$;

-- ── 2. Grant execution to service_role (cron jobs use service role) ───────

GRANT EXECUTE ON FUNCTION resolve_autoheld_meetings() TO service_role;

-- ── 3. Schedule pg_cron job ───────────────────────────────────────────────

-- Run auto-held resolution every 5 minutes
-- Commented out for manual testing — uncomment after verification
-- SELECT cron.schedule('autoheld-resolution-5min', '*/5 * * * *', 'SELECT resolve_autoheld_meetings();');

-- ── 4. Notes ──────────────────────────────────────────────────────────────

-- scheduled_start_at + window < now() ensures the meeting has PASSED and the window has CLOSED.
-- Example: meeting at June 20 14:00, 72-hour window
--   - June 20 14:00: window opens (scheduled_start_at)
--   - June 23 13:59: window NOT yet closed (eligible = false)
--   - June 23 14:00: window CLOSED (eligible = true) — auto-held trigger fires
--   - June 23 14:30: already held, locked = true, no change

-- See also: src/lib/meetings/auto-held-resolution.ts for dashboard-load resolution (MVP fallback).
