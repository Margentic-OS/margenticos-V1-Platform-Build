-- Schedule the PAID catch-all second-pass verification sweep.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- THIS ONE IS DELIBERATELY NOT APPLIED. IT IS THE MONEY SWITCH.
--
-- Every other migration in this build is inert: columns, a ledger table, a monitor view.
-- Applying them changes no behaviour and spends nothing. This file is different. The moment
-- it runs, a scheduled job begins making billed API calls against a live card, every 30
-- minutes, with no further human involvement.
--
-- The whole build is in place and tested behind this one statement. Applying it is Doug's
-- call, not a step that happens as a side effect of finishing the code, and the entire
-- session that produced it was about things that silently did the wrong thing.
--
-- WHAT IT COSTS WHEN IT RUNS. The live backlog is 11 addresses at $8 per 1,000, so the first
-- firing costs about 9 cents and then the sweep idles: it only ever selects rows whose
-- second_pass_status is NULL, so a resolved address is never re-probed. The hard ceiling is
-- SECOND_PASS_DAILY_CALL_LIMIT = 200 calls a day, or $1.60, enforced against
-- verification_calls rather than against verdicts, so failed calls count too.
--
-- HOW TO REVERSE IT:  SELECT cron.unschedule('verify-catch-all');
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY pg_cron AND NOT VERCEL CRON
--
-- Vercel Hobby permits only DAILY cron jobs. Every scheduled job in this project uses
-- Supabase pg_cron for the same reason.
--
-- WHY 30 MINUTES AND NOT 10
--
-- The free first-pass sweep runs every 10 minutes because its backlog is the whole prospect
-- list. This one spends money and its backlog is by construction a small minority: only
-- addresses the first pass could not confirm. 30 minutes drains the current backlog in one
-- firing and then idles, and idling cheaply matters more here than latency.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- THE SECRET IS NOT IN THIS FILE, AND MUST NOT BE PUT IN IT
--
-- This repository is currently PUBLIC (see CLAUDE.md). The Authorization header has to carry
-- CRON_SECRET literally, because ALTER DATABASE ... SET "app.*" needs superuser on Supabase
-- and current_setting('app.cron_secret', true) therefore returns NULL. That has cost this
-- build time twice.
--
-- So this migration does NOT write the header. It COPIES the already-authorised command from
-- the queue-worker job and rewrites only the URL path. The secret is never read, never
-- printed, and never committed.
--
-- Status: NOT APPLIED. Deliberate. See the top of this file.

-- Idempotent: unschedule any previous version of this job.
SELECT cron.unschedule('verify-catch-all')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'verify-catch-all');

SELECT cron.schedule(
  'verify-catch-all',
  '*/30 * * * *',
  replace(
    (SELECT command FROM cron.job WHERE jobname = 'queue-worker'),
    '/api/cron/queue-worker',
    '/api/cron/verify-catch-all'
  )
);
