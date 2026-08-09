-- Schedule strategy-doc-auto-approve and resolve-auto-held on pg_cron
--
-- Previously, both jobs were configured in vercel.json but invoked via GET.
-- This caused them to fail immediately with 405 Method Not Allowed,
-- since the routes export only POST handlers.
--
-- Fix: Move both to pg_cron, which invokes via POST using net.http_post.
-- Pattern matches existing jobs (process-replies, instantly-poll, auto-approve, reap-agent-runs).
--
-- To apply this migration on local/Hobby tier:
--
--   After applying, verify both jobs were created:
--     SELECT jobname, schedule FROM cron.job WHERE jobname IN ('strategy-doc-auto-approve', 'resolve-auto-held');
--
-- SECURITY NOTE:
-- CRON_SECRET lives in cron.job.command in plaintext. This is acceptable for a low-impact
-- token that gates only cron endpoints, not user-facing APIs. Higher-value credentials
-- should use Supabase Vault or an encrypted column.

-- Unschedule any existing jobs (idempotent if not present)
SELECT cron.unschedule('strategy-doc-auto-approve');
SELECT cron.unschedule('resolve-auto-held');

-- Schedule strategy-doc-auto-approve to run daily at 06:00 UTC
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

-- Schedule resolve-auto-held to run daily at 09:00 UTC
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
