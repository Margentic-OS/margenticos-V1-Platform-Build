-- Migration: remove anon and authenticated EXECUTE from every job_queue function
-- Date: 2026-08-24
--
-- Status: APPLIED (verified live 2026-08-24)
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT WENT WRONG IN THE MIGRATION BEFORE THIS ONE
--
-- 20260824160000_job_queue.sql ran, for each of its eight functions:
--
--     REVOKE ALL ON FUNCTION public.<fn>(...) FROM PUBLIC;
--     GRANT EXECUTE ON FUNCTION public.<fn>(...) TO service_role;
--
-- and that looked like it satisfied the CLAUDE.md standing rule. The verification
-- step is what caught that it did not. has_function_privilege reported anon and
-- authenticated STILL holding EXECUTE on all eight.
--
-- THE CAUSE. Supabase runs ALTER DEFAULT PRIVILEGES on the public schema granting
-- EXECUTE ON FUNCTIONS to anon, authenticated and service_role. Every function
-- created in public therefore receives EXPLICIT per-role grants at creation time.
-- REVOKE ... FROM PUBLIC removes the grant held by the PUBLIC pseudo-role, which in
-- this database was never the grant that mattered. It was a silent no-op. The stored
-- ACL read, literally:
--
--     claim_jobs: postgres=X/postgres anon=X/postgres authenticated=X/postgres service_role=X/postgres
--
-- WHY IT MATTERED. All eight functions are SECURITY DEFINER. They execute with the
-- privileges of the owner, so they bypass RLS completely. Enabling RLS on job_queue
-- with zero policies did nothing to stop them. Holding only the public anon key, an
-- unauthenticated caller could have:
--
--     enqueue_job           created jobs that spend real money on Apollo, Apify and Anthropic
--     claim_jobs            taken jobs belonging to any organisation
--     record_job_spend      falsely stamped spend. This is the worst of them: a job with
--                           spend recorded must never call the paid API again, so a false
--                           stamp permanently kills real work
--     fail_job              marked any job failed
--     complete_job          marked any job done without doing it
--     reclaim_expired_jobs  churned the entire queue
--
-- The window was about four minutes and nothing calls these functions yet, so no job
-- existed to attack. The hole was closed before any consumer was written.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- THE GENERAL LESSON, WHICH OUTLIVES THIS TABLE
--
-- On Supabase, REVOKE ... FROM PUBLIC is NOT sufficient for functions in the public
-- schema. The roles have to be named:
--
--     REVOKE EXECUTE ON FUNCTION public.<fn>(...) FROM anon, authenticated;
--
-- And the only thing that proves it worked is has_function_privilege, checked for
-- anon and authenticated as well as for the intended caller. Checking only that the
-- legitimate caller has access would have passed here while the hole stayed open.
--
-- Every other SECURITY DEFINER function in this database was audited at the same
-- time with:
--
--     SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--      WHERE n.nspname = 'public' AND p.prosecdef
--        AND has_function_privilege('anon', p.oid, 'EXECUTE');
--
-- It returned zero rows. The job_queue functions were the only ones affected.

REVOKE EXECUTE ON FUNCTION public.job_queue_backoff(integer)                     FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enqueue_job(text, uuid, uuid, text, integer)   FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_jobs(text, uuid, text, integer, integer) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.queue_next_organisations(text)                 FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_job_spend(uuid, jsonb)                  FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_job(uuid, text)                       FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fail_job(uuid, text, text, boolean)            FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reclaim_expired_jobs(integer)                  FROM anon, authenticated;

-- Re-granted rather than assumed, per the standing rule that every REVOKE ships with
-- an explicit GRANT to each legitimate caller in the same migration. Idempotent.
GRANT EXECUTE ON FUNCTION public.job_queue_backoff(integer)                     TO service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_job(text, uuid, uuid, text, integer)   TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_jobs(text, uuid, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.queue_next_organisations(text)                 TO service_role;
GRANT EXECUTE ON FUNCTION public.record_job_spend(uuid, jsonb)                  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_job(uuid, text)                       TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_job(uuid, text, text, boolean)            TO service_role;
GRANT EXECUTE ON FUNCTION public.reclaim_expired_jobs(integer)                  TO service_role;

-- Verification. Expected: every row true, false, false.
SELECT p.proname,
       has_function_privilege('service_role',  p.oid, 'EXECUTE') AS service_role_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec,
       has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon_exec
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('job_queue_backoff', 'enqueue_job', 'claim_jobs',
                     'queue_next_organisations', 'record_job_spend',
                     'complete_job', 'fail_job', 'reclaim_expired_jobs')
 ORDER BY p.proname;
