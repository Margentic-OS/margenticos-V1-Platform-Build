-- Reference data for the INTEGRATION TEST database. Not for production.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS FILE EXISTS
--
-- supabase/baseline/schema.sql captures SCHEMA ONLY. `grep -c '^INSERT INTO'`
-- against it returns 0, by design: the generator scrubs and excludes data so it
-- cannot leak a secret. So a project restored from the baseline has every table,
-- view, index, constraint and policy, and NO reference rows.
--
-- monitor_checks is the one piece of reference data the test suite actually needs.
-- monitor_events.check_code is a foreign key to monitor_checks(code), and
-- monitor-acknowledge.test.ts inserts events with check_code 'MON-001', 'MON-002'
-- and 'MON-003'. Without these rows three tests fail with
--
--   insert or update on table "monitor_events" violates foreign key constraint
--   "monitor_events_check_code_fkey"
--
-- which reads exactly like a code bug and is not one.
--
-- Before this file, those 23 rows existed in the test project only because someone
-- ran an INSERT by hand on 2026-08-27. The production rows are created by NINE
-- separate migrations, so rebuilding them meant hand-assembling nine files. If the
-- test project were ever reset, re-restored, or paused-and-rebuilt on the free
-- tier, that work was lost and the symptom was a foreign key error.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- HOW TO USE
--
--   psql "$TEST_DATABASE_URL" -f supabase/seed/test-reference-data.sql
--
-- or paste into the SQL editor of the test project. It is idempotent
-- (ON CONFLICT DO NOTHING), so running it twice is safe and running it against an
-- already-seeded project is a no-op.
--
-- NEVER run this against production. Production already has these rows from its
-- migrations, and they carry the full plain_meaning / plain_impact / plain_action
-- prose that the operator dashboard renders. The rows below deliberately omit that
-- prose: the tests only need the FK target to exist, and duplicating several
-- thousand words of operator copy here would create a second source of truth that
-- drifts. If you ever need the prose in the test project, copy it from the
-- migrations rather than from this file.

INSERT INTO public.monitor_checks (code, title, description, category, tier, is_scheduled, expected_interval_minutes) VALUES
  ('MON-001','Auto-approve hourly','Hourly cron job processes due suggestions','liveness',1,true,60),
  ('MON-002','Instantly polling every 15m','Polls Instantly API for reply state','liveness',1,true,15),
  ('MON-003','Process replies every 5m','Processes new replies from Instantly','liveness',1,true,5),
  ('MON-004','Reap agent runs every 10m','Marks zombie agent runs as failed','liveness',1,true,10),
  ('MON-005','Monitor sweep every 15m','Detects liveness failures and blind spots','liveness',1,true,15),
  ('MON-006','Client revisions awaiting review','Detects client revisions older than approval window','tier1',1,false,NULL),
  ('MON-007','Strategy doc auto-approve daily','Auto-approves strategy documents whose 3-day review window has elapsed.','liveness',1,true,1440),
  ('MON-008-UNSCHEDULED','Intake nudge (UNSCHEDULED)','Would nudge incomplete intakes. Not yet scheduled.','unscheduled',1,false,NULL),
  ('MON-009-UNSCHEDULED','Warmup halfway (UNSCHEDULED)','Would trigger warmup cascade at 50%. Not yet scheduled.','unscheduled',1,false,NULL),
  ('MON-010','Resolve auto-held daily','Auto-resolves escalations past their hold window.','liveness',1,true,1440),
  ('MON-011','Unresolved failed agent runs','Detects agent runs that failed and remain unresolved (last 7 days)','tier1',1,false,NULL),
  ('MON-012','Zombie agent runs','Detects agent runs still marked running after 15 minutes','tier1',1,false,NULL),
  ('MON-013','Orphaned campaigns','Detects campaigns with sync attempted but no external_id assigned','tier1',1,false,NULL),
  ('MON-014','Stale unprocessed signals','Detects signals not yet processed, older than 48 hours','tier1',1,false,NULL),
  ('MON-015','Permanently failed replies','Detects reply handling actions marked permanently_failed (last 7 days)','tier1',1,false,NULL),
  ('MON-016','Queue worker health','The queue worker is running on schedule AND its last run reported success.','liveness',1,true,1),
  ('MON-017','Queue is draining','Jobs are queued and eligible to run, but nothing has completed in the last 60 minutes.','blind-spot',1,false,NULL),
  ('MON-018','Queue failure rate','Terminal job failures in 24h.','blind-spot',2,false,NULL),
  ('MON-019','Email verification sweep every 10m','Confirms /api/cron/verify-pending is running and succeeding.','liveness',1,true,10),
  ('MON-020','Catch-all second-pass verification every 30m','Confirms /api/cron/verify-catch-all is running and succeeding.','liveness',2,true,30),
  ('MON-021','Synthesis batch pipeline every 5m','Confirms /api/cron/synthesis-batch-sweep is running and succeeding.','liveness',1,true,5),
  ('MON-022','Batch research safety guarantees intact','Reads the live catalog to confirm batch research safety guarantees.','data_integrity',1,false,NULL),
  ('MON-023','Sending domain bounce health','Per sending domain over a rolling 7 days.','blind-spot',1,false,NULL)
ON CONFLICT (code) DO NOTHING;

-- integrations_registry is NOT seeded here. Production has 15 rows and the test
-- project has none, and that is currently correct: no test in the eight loads the
-- registry. handleUploadLeads.compliance.test.ts does not import handleUploadLeads
-- at all; it exercises the pre-upload gates directly with raw queries.
--
-- If a future test does exercise a capability handler, the symptom will be
-- 'registry-cache: integrations_registry is empty — no capabilities are active',
-- and the rows belong here, derived from the migrations rather than copied from
-- production, because production rows carry live connection state.
