-- Migrate reap-agent-runs from Vercel cron (Hobby incompatible) to Supabase pg_cron
--
-- Background: reap-agent-runs was scheduled on Vercel with "*/5 * * * *" (every 5 min).
-- Vercel Hobby tier only permits daily crons (once per day), causing all deploys to fail.
-- Solution: move to pg_cron (like instantly-poll, process-replies, auto-approve).
--
-- Frequency: every 10 minutes (*/10 * * * *). Threshold is 10 min, so 10-min polling
-- is safe and matches the timeout threshold for detecting zombie runs.
--
-- Job registration: 'reap-agent-runs' (must match jobname in cron.job table)
-- To verify:   SELECT jobname, schedule, command FROM cron.job WHERE jobname = 'reap-agent-runs';
-- To remove:   SELECT cron.unschedule('reap-agent-runs');
--
-- SUPABASE HOBBY LIMITATION (discovered 2026-04-29):
--   ALTER DATABASE postgres SET "app.*" requires superuser / supabase_admin role.
--   The Supabase SQL editor runs as the postgres role — permission denied.
--   current_setting('app.cron_secret', true) therefore returns NULL and
--   the reaper endpoint receives Authorization: Bearer (empty), resulting in 401.
--
--   WORKING PATTERN ON HOBBY TIER:
--   After applying this migration, immediately reschedule the cron job with CRON_SECRET hardcoded:
--
--     SELECT cron.unschedule('reap-agent-runs');
--     SELECT cron.schedule(
--       'reap-agent-runs', '*/10 * * * *',
--       $cmd$
--       SELECT net.http_post(
--         url     := 'https://margenticos-platform.vercel.app/api/cron/reap-agent-runs',
--         headers := '{"Content-Type":"application/json","Authorization":"Bearer <CRON_SECRET>"}'::jsonb,
--         body    := '{}'::jsonb,
--         timeout_milliseconds := 55000
--       );
--       $cmd$
--     );
--
--   Replace <CRON_SECRET> with the value from Vercel → Project → Settings → Environment Variables.
--
--   SECURITY NOTE:
--   CRON_SECRET lives in cron.job.command in plaintext. Acceptable for this token
--   (low-impact trigger, gates only cron endpoints). Do NOT use this pattern for API keys
--   or higher-value credentials.

-- Unschedule any existing job (idempotent if not present)
SELECT cron.unschedule('reap-agent-runs');

-- Schedule the reaper to run every 10 minutes via pg_cron
SELECT cron.schedule(
  'reap-agent-runs',
  '*/10 * * * *',
  $$
  SELECT
    net.http_post(
      url     := 'https://margenticos-platform.vercel.app/api/cron/reap-agent-runs',
      headers := jsonb_build_object(
                   'Content-Type',  'application/json',
                   'Authorization', 'Bearer ' || current_setting('app.cron_secret', true)
                 ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 55000
    );
  $$
);
