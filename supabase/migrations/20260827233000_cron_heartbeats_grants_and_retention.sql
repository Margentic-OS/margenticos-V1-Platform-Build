-- cron_heartbeats: take the anon grant off it, and stop it growing forever.
--
-- Status: APPLIED (verified live 2026-08-27)
--
-- Read-back after apply, every privilege, both directions:
--   cron_heartbeats         anon and authenticated: all eight false. service_role: all true.
--   cron_heartbeats_id_seq  anon and authenticated: USAGE and SELECT false. service_role: true.
--   cron.job                jobid 19, 'cron-heartbeats-retention', '17 3 * * *', active.
--
-- The DELETE was proved rather than waited for, inside BEGIN ... ROLLBACK, with a synthetic
-- 120-day-old success, a synthetic 120-day-old failure, and the REAL 2026-08-23 incident row
-- (id 10099) temporarily aged to 200 days:
--
--   old success  -> deleted
--   old failure  -> survived
--   id 10099     -> SURVIVED at 200 days old, which proves the rule rather than the calendar
--   heartbeat    -> "Pruned 1 successful heartbeat(s) older than 90 days. Failures are
--                    never pruned."
--
-- ═════════════════════════════════════════════════════════════════════════════
-- PART ONE: THE GRANT
--
-- anon held all eight privileges on this table, with RLS as the only thing stopping it.
-- That is the exact shape of the 2026-08-25 verification_calls finding: RLS held, and it
-- was the single layer, so one later migration adding a permissive policy or disabling RLS
-- to debug something would have opened it with nothing underneath and nothing to say so.
--
-- It is MOOT for MON-002 and MON-003 specifically, which is worth stating so nobody
-- re-derives it: those two views were made security_invoker on 2026-08-27, so they consult
-- RLS as the caller and no longer leak this table's contents to anon. That fixed the
-- reachable path. It did not remove the grant, and the grant is what this migration is
-- about.
--
-- authenticated already held nothing here, so revoking it by name is a no-op today. It is
-- written anyway, because CLAUDE.md's rule is that the revoke names all three and the
-- privilege is read back for each: an assumed grant state is how both the 2026-06-05 and
-- 2026-08-24 incidents happened.
--
-- The policy cron_heartbeats_operator_read (SELECT TO authenticated) is LEFT IN PLACE and
-- is inert, because a policy without a grant underneath it grants nothing. Removing it is
-- not this migration's business, and it documents an intent that may come back.
--
-- Nothing in src/ reads this table as a client: every reference is a cron route using the
-- service client.

REVOKE ALL ON TABLE public.cron_heartbeats FROM PUBLIC;
REVOKE ALL ON TABLE public.cron_heartbeats FROM anon, authenticated;
GRANT ALL ON TABLE public.cron_heartbeats TO service_role;

-- The sequence too. A grant on the table without USAGE on its sequence is a broken INSERT,
-- and a revoke on the table that forgets the sequence leaves a reachable object behind.
REVOKE ALL ON SEQUENCE public.cron_heartbeats_id_seq FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.cron_heartbeats_id_seq FROM anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.cron_heartbeats_id_seq TO service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART TWO: RETENTION
--
-- MEASURED FIRST, 2026-08-27: 17,906 rows across 11 jobs, oldest 2026-08-08, 2,571 rows
-- written in the last 24 hours, 3.7 MB total. That is roughly 940,000 rows and 68 MB a
-- year, growing linearly and for ever, on a table whose entire purpose is answering "did
-- this job run recently".
--
-- THE CHOICE: keep 90 DAYS of successful heartbeats. Delete nothing else, ever.
--
-- Why 90 and not the 30 that was asked for as a floor. Thirty days answers "is it running
-- now". Ninety answers "when did this start", which is the question you actually have
-- during an incident, and it spans a full quarter so a campaign cycle can be compared
-- against the one before it. The cost of the extra sixty days is about 235,000 rows and
-- 45 MB, which is not a number worth optimising against the cost of not being able to
-- answer.
--
-- WHY FAILURES ARE NEVER PRUNED, on any schedule. There are TWO failure rows in the whole
-- table:
--
--   2026-08-23 21:15  instantly-poll     zero successful Instantly calls, 2 errors
--   2026-08-26 02:00  verify-catch-all   BOUNCER_API_KEY is not set
--
-- The first is the only surviving record of a real production incident. At two rows in
-- twenty days, keeping every failure for ever costs about 36 rows a year, and any window
-- long enough to be useful is also long enough to eventually delete that row. Making the
-- rule "ok = true only" removes the possibility rather than pushing it further away, which
-- is the difference between a policy and a delay.
--
-- Note the practical consequence for verifying this: NOTHING IS OLDER THAN 30 DAYS TODAY,
-- so the first several runs will delete zero rows. A job that deletes nothing looks
-- identical to a job that is broken, which is why it writes its own heartbeat row saying
-- what it pruned, and why the read-back below proves the DELETE against a synthetic old
-- row inside a rolled-back transaction rather than waiting 90 days to find out.
--
-- The job writes a heartbeat but NO MONITOR WATCHES IT YET. Logged in BACKLOG rather than
-- left implied.

SELECT cron.unschedule('cron-heartbeats-retention')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cron-heartbeats-retention');

SELECT cron.schedule(
  'cron-heartbeats-retention',
  '17 3 * * *',
  $retention$
  WITH deleted AS (
    DELETE FROM public.cron_heartbeats
     WHERE ok AND ran_at < now() - interval '90 days'
    RETURNING 1
  )
  INSERT INTO public.cron_heartbeats (job_name, ran_at, ok, detail)
  SELECT 'cron-heartbeats-retention', now(), true,
         'Pruned ' || count(*) || ' successful heartbeat(s) older than 90 days. '
         || 'Failures are never pruned.'
    FROM deleted
  $retention$
);

-- 03:17 rather than the top of an hour: every other scheduled job in this database fires
-- on the hour, on the quarter or every five minutes, and a DELETE that takes a lock is
-- better placed where nothing else is starting.
