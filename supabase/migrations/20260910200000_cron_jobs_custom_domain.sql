-- Status: NOT YET APPLIED. Apply only after this file is on origin/main.
--
-- Move the pg_cron HTTP jobs that still post to margenticos-platform.vercel.app onto
-- app.margenticos.com, so every HTTP job uses one hostname.
--
-- WHY. Both hostnames are aliases on the same Vercel project (prj_cSdFlPFqqcCtcK9RPa0AFMziTye5)
-- serving the same production deployment, so this changes no behaviour today. It removes a
-- second place to touch when the domain changes. The split was chronological, not chosen:
-- the older jobs were created on the vercel.app alias and never moved. The jobs already on
-- the custom domain include queue-worker, which proves every minute that the custom domain
-- serves /api/cron/*.
--
-- WHAT THIS DELIBERATELY DOES NOT CHANGE. The pg_net timeout. Six jobs give the caller 55s
-- on routes declaring maxDuration = 300, which is a separate Before-scale decision in the
-- Notion Backlog ("Six of twelve crons give the caller 55s ..."). Only the host moves.
--
-- WHY A SERVER-SIDE replace(). cron.job.command carries a hardcoded bearer token (see the
-- stagger migration for why). Passing a new command to alter_job would mean writing the
-- token into this file. replace() rewrites only the host, inside the database, so the token
-- is never read out and never appears here.
--
-- VERIFY AFTER APPLYING: every HTTP job's URL host is app.margenticos.com, and
-- md5(replace(command, 'https://app.margenticos.com/', 'https://margenticos-platform.vercel.app/'))
-- equals the md5 of the command captured before, which proves the host is the ONLY change.

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT jobid, command FROM cron.job
            WHERE command LIKE '%https://margenticos-platform.vercel.app/%'
  LOOP
    PERFORM cron.alter_job(
      r.jobid,
      command => replace(r.command, 'https://margenticos-platform.vercel.app/', 'https://app.margenticos.com/')
    );
  END LOOP;
END $$;
