-- Schedule the email verification sweep.
--
-- WHY THIS EXISTS
--
-- Verification had exactly one caller: an operator route with no button, no cron and no job
-- type. Every verdict in the database was written by a manual script in one window on
-- 2026-08-10, and nothing has verified an address since.
--
-- That became load-bearing on 2026-08-25, when the research spend gate began FAILING CLOSED
-- on a missing verdict. A prospect with no verdict is now refused research, so a
-- verification step that never runs does not degrade the pipeline: it silently halts it.
--
-- WHY pg_cron AND NOT VERCEL CRON
--
-- Vercel Hobby permits only DAILY cron jobs. Every scheduled job in this project uses
-- Supabase pg_cron for the same reason. See 20260807_reap_agent_runs_pg_cron.sql and
-- 20260824160000_job_queue.sql.
--
-- WHY NOT A FOURTH QUEUE JOB TYPE
--
-- The queue's central mechanism is the spend stamp, which exists so a reclaimed job cannot
-- pay twice for an expensive non-idempotent call. Verification is an idempotent lookup
-- against a free tier: there is no spend to stamp. A fourth job type would need JOB_TYPES, a
-- config entry, a flag row, a handler entry, an executor, an enqueue helper, three test
-- files, and a migration dropping and recreating the job_queue_type_valid CHECK constraint,
-- to buy a guarantee that does not apply here. Revisit if verification ever becomes paid
-- per address — the trigger is a price on the call, not a growth in volume.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- THE SECRET IS NOT IN THIS FILE, AND MUST NOT BE PUT IN IT
--
-- This repository is currently PUBLIC (see CLAUDE.md). The Authorization header has to
-- carry CRON_SECRET literally, because ALTER DATABASE ... SET "app.*" needs superuser on
-- Supabase and current_setting('app.cron_secret', true) therefore returns NULL — a mistake
-- that has cost this build time twice.
--
-- So this migration does NOT write the header. It COPIES the already-authorised command
-- from the queue-worker job and rewrites only the URL path. The secret is never read, never
-- printed, and never committed. If queue-worker is ever unscheduled, re-point this at
-- another live job or reschedule by hand with the secret substituted.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Status: APPLIED (verified live 2026-08-25)

-- Idempotent: unschedule any previous version of this job.
SELECT cron.unschedule('verify-pending')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'verify-pending');

-- Every 10 minutes. The sweep serves ONE organisation per invocation, oldest backlog first,
-- and the free tier is 100/day across the whole account, so a single sweep can exhaust the
-- day's quota on its own. Fanning out would buy nothing.
SELECT cron.schedule(
  'verify-pending',
  '*/10 * * * *',
  replace(
    (SELECT command FROM cron.job WHERE jobname = 'queue-worker'),
    '/api/cron/queue-worker',
    '/api/cron/verify-pending'
  )
);
