-- Status: APPLIED (verified live 2026-09-11). Recorded remotely as 20260911143130 on
-- production and 20260911143133 on the test project.
--
-- READ BACK, production (DATABASE-EVIDENCED): alert_pending is boolean NOT NULL DEFAULT
-- false; 0 of the 120 existing rows read true, so nothing is owed and nothing can re-send.
-- The deployed sweep, which predates the code that uses this column, ran at 14:35:03 UTC
-- against it: ok=true, 29 monitors checked. The new alert rule itself is not live until the
-- branch carrying alert-policy.ts merges and deploys.
--
-- A monitor alert is sent on the SECOND consecutive failing sweep, not the first. The first
-- failure is still recorded, and shown on the dashboard, at once; only the alert waits.
-- The logic is in src/app/api/cron/monitor-sweep/alert-policy.ts. See ADR-055.
--
-- WHY. DATABASE-EVIDENCED, production monitor_events, 2026-09-10 18:00 to 2026-09-11 14:05
-- UTC: 19 PROBLEM transitions across six checks, each followed by OK, each raising a Sentry
-- error at the moment it happened:
--   MON-005 x8   MON-002 x4   MON-027 x2   MON-016 x2   MON-026 x2   MON-021 x1
-- 16 of the 19 cleared on the very next sweep. The cause is the Supabase gateway cutting reads
-- at five seconds, which this does not touch.
--
-- WHAT. One column. alert_pending = true on a PROBLEM row means: this failure is recorded, and
-- its alert is owed if the next reading is still PROBLEM. The sweep clears it when it sends,
-- and when the check recovers first.
--
-- WHY DEFAULT false, AND WHY THIS IS SAFE TO APPLY BEFORE THE CODE MERGES. The deployed sweep
-- does not know this column. It writes PROBLEM rows without it and alerts on the spot, so for
-- its rows "no alert owed" is exactly true, and false is what they get. When the new sweep
-- deploys, no row written by the old one can send a second email. No backfill: every existing
-- row already holds the right value.
--
-- Grants unchanged; a new column inherits the table's. Read back after applying, in both
-- directions: service_role holds SELECT, INSERT, UPDATE and DELETE; anon and authenticated
-- hold none of the four; RLS is on. (This comment first said authenticated reads through the
-- operator RLS policy. It does not: authenticated holds no SELECT, so that policy is never
-- reached, and the operator routes read monitor_events with the service client.)

ALTER TABLE public.monitor_events
  ADD COLUMN IF NOT EXISTS alert_pending boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.monitor_events.alert_pending IS
  'True on a PROBLEM row whose alert has not been sent yet. The monitor sweep sends it on the '
  'second consecutive PROBLEM reading and clears this; a recovery first clears it unsent.';
