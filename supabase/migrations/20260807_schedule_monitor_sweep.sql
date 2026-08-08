-- Schedule monitor-sweep cron job on pg_cron
-- Runs every 15 minutes to check all monitors and record state transitions.
--
-- Pattern: matches reap-agent-runs (hardcoded CRON_SECRET in command).
-- To verify: SELECT jobname, schedule, command FROM cron.job WHERE jobname = 'monitor-sweep';
-- To remove: SELECT cron.unschedule('monitor-sweep');

SELECT cron.unschedule('monitor-sweep');

SELECT cron.schedule(
  'monitor-sweep',
  '*/15 * * * *',
  $$
  SELECT
    net.http_post(
      url     := 'https://margenticos-platform.vercel.app/api/cron/monitor-sweep',
      headers := jsonb_build_object(
                   'Content-Type',  'application/json',
                   'Authorization', 'Bearer REDACTED_CRON_SECRET_IN_COMMAND'
                 ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 55000
    );
  $$
);
