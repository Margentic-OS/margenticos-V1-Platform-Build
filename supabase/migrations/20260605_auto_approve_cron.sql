-- /api/cron/auto-approve — hourly pg_cron job
--
-- Vercel Hobby silently rejects sub-daily cron expressions. The hourly
-- auto-approve trigger must therefore run from pg_cron instead.
--
-- This migration registers the job skeleton. The command uses a
-- placeholder URL and token — reschedule manually after applying (see below).
--
-- AFTER APPLYING THIS MIGRATION:
--   Run the following in the Supabase SQL editor (or via MCP execute_sql)
--   with the real CRON_SECRET value substituted:
--
--     SELECT cron.unschedule('auto-approve') WHERE EXISTS (
--       SELECT 1 FROM cron.job WHERE jobname = 'auto-approve'
--     );
--     SELECT cron.schedule(
--       'auto-approve', '0 * * * *',
--       $cmd$
--       SELECT net.http_post(
--         url     := 'https://app.margenticos.com/api/cron/auto-approve',
--         headers := '{"Content-Type":"application/json","Authorization":"Bearer <CRON_SECRET>"}'::jsonb,
--         body    := '{}'::jsonb,
--         timeout_milliseconds := 55000
--       );
--       $cmd$
--     );
--
-- SECURITY NOTE:
--   CRON_SECRET lives in cron.job.command in plaintext. Acceptable for this
--   token — it is a low-impact trigger secret (gates only the cron endpoints,
--   not client data). NOT acceptable for higher-value credentials (API keys,
--   client secrets). Use Supabase Vault for those.
--   CRON_SECRET value: Vercel → Project → Settings → Environment Variables.
--
-- VERIFY after rescheduling:
--   SELECT jobname, schedule FROM cron.job WHERE jobname = 'auto-approve';

BEGIN;

-- Idempotent: unschedule if a previous attempt left a stale job.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auto-approve') THEN
    PERFORM cron.unschedule('auto-approve');
  END IF;
END
$$;

-- Register with placeholder — reschedule with real secret immediately after.
SELECT cron.schedule(
  'auto-approve', '0 * * * *',
  $cmd$
  SELECT net.http_post(
    url     := 'https://app.margenticos.com/api/cron/auto-approve',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer <CRON_SECRET>"}'::jsonb,
    body    := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $cmd$
);

COMMIT;
