-- Status: APPLIED (verified live 2026-09-12)
--   production hjpvnvjryxdjcfdsfhzy: cron.job jobid 13 read back active = false (was true),
--     cron_schedule_registry active = false, declared_by this file.
--   test tidqheqjzvwmrrrebzir: no pg_cron job of this name exists, so the DO block was a
--     no-op there as designed; the registry row read back active = false.
--
-- Pause the daily resolve-auto-held job. See ADR-057.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT
--
-- Sets pg_cron job 'resolve-auto-held' to active = false, and declares it off in
-- cron_schedule_registry so a rebuild from these migrations keeps it off. The job row, its
-- schedule and its command are left exactly as they are. Nothing is deleted, and the bearer
-- token the command carries never passes through this file.
--
-- PAUSED, NOT UNSCHEDULED, for the same reason as the auto-approve pause (20260910230000):
-- cron.unschedule() deletes the only stored copy of the command, and re-creating it would
-- mean writing the token into a migration.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY
--
-- The job marked every booked meeting HELD and BILLABLE 72 hours after its scheduled start,
-- recorded as confirmed by 'auto', with no human involved. Booking detection went live on
-- 2026-09-11 (ADR-056), so the first real booking would have been billed three days after
-- the meeting whether or not anyone attended.
--
-- It was never part of the pricing decision of 2026-08-24 ("Bill on held meetings only,
-- with a two-month confirmation window"), which bills an unconfirmed meeting at the END OF
-- THE FOLLOWING MONTH, not after 72 hours. The 72-hour job was built separately. The
-- monthly backstop that the decision does describe is built on branch meeting-outcomes.
--
-- It has never billed anything: production held 0 meetings when this was written.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT STOPS WITH IT
--
--   1. The 72-hour auto-held billing. That is the point.
--   2. The 'resolve-auto-held' heartbeat. MON-010 reads only that heartbeat, not the
--      registry, so it turns PROBLEM about 25 hours after the last run ("over 1500 minutes
--      ago"). That is a true statement about a stopped job. MON-001 and MON-025 read the
--      registry and report the job as switched off, as declared.
--   3. Sentry's cron monitor for this job reports missed check-ins.
--
-- WHAT DOES NOT STOP. Booking detection, cancellation and rescheduling
-- (record-booking-event.ts). The confirm route. Nothing else calls this job.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- DO NOT RESUME THE 72-HOUR BEHAVIOUR. If this job is resumed it must first be running the
-- replacement code, which bills an unconfirmed meeting only at the end of the following
-- month (ADR-057). Resuming it on the old code turns the 72-hour billing back on.
--
-- Production and the test project both carry the registry row; the pause is conditional
-- on the pg_cron job existing and being active, so it is a no-op wherever it does not.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'resolve-auto-held' AND active) THEN
    PERFORM cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'resolve-auto-held'), active => false);
  END IF;
END $$;

-- active is the THIRD column on purpose: the CI scan reads it by position.
INSERT INTO public.cron_schedule_registry (jobname, schedule, active, declared_by, notes) VALUES
  ('resolve-auto-held', '9 9 * * *', false, '20260911210000_pause_resolve_auto_held.sql',
     'Paused 2026-09-11 (ADR-057): it marked meetings held and billable 72 hours after start with no human. Never part of the 2026-08-24 pricing decision. Do not resume on the old code.')
ON CONFLICT (jobname) DO UPDATE SET
  schedule    = EXCLUDED.schedule,
  active      = EXCLUDED.active,
  declared_by = EXCLUDED.declared_by,
  notes       = COALESCE(EXCLUDED.notes, public.cron_schedule_registry.notes),
  updated_at  = now();
