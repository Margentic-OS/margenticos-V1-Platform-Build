-- verify-catch-all runs every 10 minutes, not every 30.
--
-- Status: APPLIED (verified live 2026-09-03). cron.job verify-catch-all: */10 * * * *, active.
-- No-op against production as it stood, which is the intended shape.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY THIS IS A NEW MIGRATION RATHER THAN AN EDIT TO THE OLD ONE
--
-- 20260826002500_verify_catch_all_pg_cron.sql declares '*/30 * * * *' and is APPLIED. The
-- schedule was changed live with cron.alter_job on 2026-09-01 and the file was not touched,
-- so the repository and the database have disagreed since.
--
-- The failure mode is quiet and specific: replaying that migration, which is a reasonable
-- thing to do when rebuilding an environment, silently puts the job back on 30 minutes.
-- Nothing reports it. The sweep keeps running, on time, at a third of the intended rate.
--
-- Migrations are append-only, so the old file keeps its history and this one carries the
-- correction. Anything comparing live state to "what the migrations declare" must therefore
-- read the LAST declaration for a job name, not the first. cron_schedule_registry below is
-- that answer, written down once.
--
-- This is a no-op against production as it stands, which is the intended shape: the
-- repository is being brought up to the database, not the other way round.

-- alter_job rather than unschedule+schedule: it preserves the command, and the command
-- carries CRON_SECRET as a literal that must never be written into a file in this
-- repository. See the header of the 2026-08-25 verify-pending migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'verify-catch-all') THEN
    PERFORM cron.alter_job(
      (SELECT jobid FROM cron.job WHERE jobname = 'verify-catch-all'),
      schedule := '*/10 * * * *'
    );
  END IF;
END $$;

-- Read back after applying:
--   SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname = 'verify-catch-all';
--   SELECT * FROM public.mon_025;
