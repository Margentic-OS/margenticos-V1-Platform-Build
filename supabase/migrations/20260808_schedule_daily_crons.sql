-- Schedule strategy-doc-auto-approve and resolve-auto-held on pg_cron
--
-- Previously, both jobs were configured in vercel.json but invoked via GET.
-- This caused them to fail immediately with 405 Method Not Allowed,
-- since the routes export only POST handlers.
--
-- Fix: Move both to pg_cron, which invokes via POST using net.http_post.
-- Pattern matches existing jobs (process-replies, instantly-poll, auto-approve, reap-agent-runs).
--
-- SUPABASE HOBBY LIMITATION (discovered 2026-08-08, matches reaper pattern):
--   Supabase Hobby tier cannot set app.* config vars via ALTER DATABASE.
--   The current_setting('app.cron_secret') pattern returns NULL — jobs fail with 401.
--
--   WORKING PATTERN ON HOBBY TIER (applied by human operator):
--   After applying this migration, manually reschedule both jobs with hardcoded CRON_SECRET:
--
--     SELECT cron.unschedule('strategy-doc-auto-approve');
--     SELECT cron.unschedule('resolve-auto-held');
--
--     SELECT cron.schedule('strategy-doc-auto-approve', '0 6 * * *',
--       $cmd$ SELECT net.http_post(
--         url     := 'https://margenticos-platform.vercel.app/api/cron/strategy-doc-auto-approve',
--         headers := '{"Content-Type":"application/json","Authorization":"Bearer <CRON_SECRET>"}'::jsonb,
--         body    := '{}'::jsonb,
--         timeout_milliseconds := 55000
--       ); $cmd$);
--
--     SELECT cron.schedule('resolve-auto-held', '0 9 * * *',
--       $cmd$ SELECT net.http_post(
--         url     := 'https://margenticos-platform.vercel.app/api/cron/resolve-auto-held',
--         headers := '{"Content-Type":"application/json","Authorization":"Bearer <CRON_SECRET>"}'::jsonb,
--         body    := '{}'::jsonb,
--         timeout_milliseconds := 55000
--       ); $cmd$);
--
--   Replace <CRON_SECRET> with the actual value from Vercel environment.
--
-- SECURITY NOTE:
-- CRON_SECRET lives in cron.job.command in plaintext. Acceptable for a low-impact
-- token that gates only cron endpoints, not user-facing APIs. Higher-value credentials
-- should use Supabase Vault or an encrypted column.

-- Dummy schedules below will be unscheduled and rescheduled manually on Hobby tier.
-- This migration records the intent; the actual live jobs use hardcoded Bearer tokens.

-- NOTE: On Hobby tier, the current_setting pattern below DOES NOT WORK.
-- Jobs must be rescheduled manually with hardcoded CRON_SECRET as documented above.
-- If replaying this migration on a new tier, verify cron.job contains literal Bearer tokens,
-- not current_setting references.

SELECT cron.schedule(
  'strategy-doc-auto-approve',
  '0 6 * * *',
  $$
  SELECT
    net.http_post(
      url     := 'https://margenticos-platform.vercel.app/api/cron/strategy-doc-auto-approve',
      headers := jsonb_build_object(
                   'Content-Type',  'application/json',
                   'Authorization', 'Bearer ' || current_setting('app.cron_secret', true)
                 ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 55000
    );
  $$
);

SELECT cron.schedule(
  'resolve-auto-held',
  '0 9 * * *',
  $$
  SELECT
    net.http_post(
      url     := 'https://margenticos-platform.vercel.app/api/cron/resolve-auto-held',
      headers := jsonb_build_object(
                   'Content-Type',  'application/json',
                   'Authorization', 'Bearer ' || current_setting('app.cron_secret', true)
                 ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 55000
    );
  $$
);
