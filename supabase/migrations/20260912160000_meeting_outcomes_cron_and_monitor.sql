-- Status: NOT YET APPLIED
--   Deliberately. This file needs the real CRON_SECRET in the job command, which must never
--   be written into a migration, and the route it calls does not exist on production until
--   this branch merges. Apply it AFTER the merge, substituting the secret at apply time, then
--   read back cron.job and mon_010 and mark this APPLIED.
--
-- The daily meeting-outcome job, and mon_010 repointed at it. See ADR-057.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT CHANGES
--
-- 1. A new daily job, 'meeting-outcomes' at 09:34 UTC. It asks clients whether their
--    meetings happened, reminds them working back from the real deadline, and applies the
--    monthly backstop from the 2026-08-24 pricing decision.
--
-- 2. mon_010 now reads THAT job's heartbeat instead of resolve-auto-held's.
--
-- The 09:34 slot was picked by reading cron.job live on 2026-09-12: the only other daily jobs
-- are cron-heartbeats-retention at 03:19 and the paused resolve-auto-held at 09:09, so nothing
-- else starts in that minute. The stagger of 2026-09-10 exists to stop ten jobs starting in
-- the same second and this keeps to it.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY resolve-auto-held IS LEFT PAUSED RATHER THAN UNSCHEDULED
--
-- Its ROUTE AND LIBRARY ARE DELETED in this commit, so the 72-hour behaviour cannot run even
-- if somebody reactivates the job: the POST would 404. The pg_cron row is left paused and
-- declared off (20260911210000) for two reasons. cron.unschedule() deletes the only stored
-- copy of the command, which carries a bearer token, so recreating it would mean writing that
-- token into a file. And MON-025 compares cron.job against cron_schedule_registry, so a job
-- somebody switches back on with the registry still saying off goes RED immediately, which is
-- a better outcome than the row simply being absent.
--
-- MON-025 WILL GO RED BETWEEN THIS MIGRATION AND THE LIVE JOB BEING CREATED, because the
-- registry will declare a job that cron.job does not yet hold. That is the drift check doing
-- its job, and it is the correct order: declare first, then create. Create the live job in the
-- same session as applying this.

-- ── 1. The job ──────────────────────────────────────────────────────────────
--
-- Unschedule-then-schedule is the idempotent shape used by every cron migration here.
-- To verify:  SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'meeting-outcomes';
-- To remove:  SELECT cron.unschedule('meeting-outcomes');
--
-- REPLACE THE PLACEHOLDER with the real CRON_SECRET when applying. Never commit the value.

SELECT cron.unschedule('meeting-outcomes');

SELECT cron.schedule(
  'meeting-outcomes',
  '34 9 * * *',
  $$
  SELECT
    net.http_post(
      url     := 'https://margenticos-platform.vercel.app/api/cron/meeting-outcomes',
      headers := jsonb_build_object(
                   'Content-Type',  'application/json',
                   'Authorization', 'Bearer REDACTED_CRON_SECRET_IN_COMMAND'
                 ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 55000
    );
  $$
);

-- active is the THIRD column on purpose: the CI scan reads it by position.
INSERT INTO public.cron_schedule_registry (jobname, schedule, active, declared_by, notes) VALUES
  ('meeting-outcomes', '34 9 * * *', true, '20260912160000_meeting_outcomes_cron_and_monitor.sql',
     'Asks clients to confirm meetings, reminds working back from the real deadline, and bills unconfirmed meetings at the end of the following month (ADR-057). Replaces the 72-hour resolve-auto-held job.')
ON CONFLICT (jobname) DO UPDATE SET
  schedule    = EXCLUDED.schedule,
  active      = EXCLUDED.active,
  declared_by = EXCLUDED.declared_by,
  notes       = COALESCE(EXCLUDED.notes, public.cron_schedule_registry.notes),
  updated_at  = now();

-- ── 2. mon_010 ──────────────────────────────────────────────────────────────
--
-- MOVED OUT of this file into 20260912170000_mon_010_watches_meeting_outcomes.sql, and
-- APPLIED there on 2026-09-12.
--
-- It was here first, and that was a mistake: the view repoint needs no secret and depends on
-- no deployed code, so bundling it with the pg_cron job that needs BOTH meant the live view
-- went on reading the heartbeat of a deleted job while the code and its tests had moved to
-- the new one. Six tests failed on exactly that disagreement.
--
-- So mon_010 already watches `meeting-outcomes` and currently reports UNKNOWN with
-- "meeting-outcomes has never reported. Check the pg_cron job exists and is active." Applying
-- section 1 above is what makes it report OK.
