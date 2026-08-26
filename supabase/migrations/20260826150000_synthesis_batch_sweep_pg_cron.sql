-- Schedule the synthesis batch sweep.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- NOT APPLIED. IT HAS A PREREQUISITE THAT IS NOT MET YET.
--
-- The cron POSTs to https://app.margenticos.com, which serves MAIN. This route exists only
-- on the batch-synthesis branch. Scheduling it now would produce a 404 every five minutes,
-- zero work done, and a failing heartbeat that looks like a broken sweep rather than a
-- missing deploy. That exact mistake was caught on verify-catch-all and the ordering note
-- was written into its migration; this file inherits it.
--
-- PREREQUISITES, IN ORDER:
--   1. Merge to main and deploy to production.
--   2. Confirm the route exists and is gated:
--        POST https://app.margenticos.com/api/cron/synthesis-batch-sweep  ->  401, not 404
--   3. Apply this migration.
--
-- HOW TO REVERSE IT:  SELECT cron.unschedule('synthesis-batch-sweep');
--
-- ═════════════════════════════════════════════════════════════════════════════
-- IS THIS A MONEY SWITCH?
--
-- Less than verify-catch-all's, and worth stating precisely rather than reassuringly.
--
-- The sweep only ever submits entries in 'pending_submission', and the only thing that
-- creates one is a research_sources job, which only runs when queue_research_sources is
-- true. That flag is false and is mutually exclusive with queue_research. So with the
-- flags as they are, this schedule fires every five minutes, finds nothing, writes a
-- heartbeat and idles at zero cost.
--
-- The flag flip is the money switch. This is the machinery that acts on it, and it should
-- be running and provably idle BEFORE that flip, not scheduled at the same moment.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY FIVE MINUTES
--
-- Chosen for the SUBMIT side, not the poll side. Most batches finish inside an hour and
-- the whole change trades latency for a discount, so polling faster buys nothing. But an
-- entry written by phase 1 waits at most five minutes before joining a batch, which keeps
-- one client's prospects close together in time and therefore sharing one cached prefix.
-- Cache reads bill at about a tenth of input and the system prompt is ~6,700 tokens, so
-- that closeness is worth roughly a third of the saving.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY pg_cron AND NOT VERCEL CRON
--
-- Vercel Hobby permits only DAILY cron jobs. Every scheduled job in this project uses
-- Supabase pg_cron for the same reason.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- THE SECRET IS NOT IN THIS FILE, AND MUST NOT BE PUT IN IT
--
-- This repository is currently PUBLIC (see CLAUDE.md). The Authorization header has to
-- carry CRON_SECRET literally, because ALTER DATABASE ... SET "app.*" needs superuser on
-- Supabase and current_setting('app.cron_secret', true) therefore returns NULL.
--
-- So this migration does NOT write the header. It COPIES the already-authorised command
-- from the queue-worker job and rewrites only the URL path. The secret is never read,
-- never printed, and never committed.
--
-- Status: NOT APPLIED. Awaiting the production deploy above and Doug's go-ahead.

-- Idempotent: unschedule any previous version of this job.
SELECT cron.unschedule('synthesis-batch-sweep')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'synthesis-batch-sweep');

SELECT cron.schedule(
  'synthesis-batch-sweep',
  '*/5 * * * *',
  replace(
    (SELECT command FROM cron.job WHERE jobname = 'queue-worker'),
    '/api/cron/queue-worker',
    '/api/cron/synthesis-batch-sweep'
  )
);
