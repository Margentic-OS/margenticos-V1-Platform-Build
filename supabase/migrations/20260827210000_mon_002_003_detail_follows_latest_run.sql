-- MON-002 and MON-003: bind `detail` to the most recent run, not to max() over all history.
--
-- Status: APPLIED (verified live 2026-08-27)
--
-- Read-back after apply, both views:
--   security_invoker -> true
--   service_role SELECT -> true | anon SELECT -> false | authenticated SELECT -> false
--
-- And tested as the roles themselves, not inferred from the grant table:
--   SET ROLE service_role; SELECT * FROM public.mon_002;  -> returns the row
--   SET ROLE anon;         SELECT * FROM public.mon_002;  -> ERROR 42501 permission denied
--
-- Rendered output proved to have CHANGED, which is the check that matters:
--   BEFORE: detail = 'Run failed: 2 error(s) ... external_id b1234567-mock-4000-a000-
--                     staging000001 has no Instantly analytics row'   (frozen 4 days)
--   AFTER:  detail = 'Last run: 2026-08-27 20:15:04 UTC'
--
-- Behaviour proved with synthetic heartbeats inside BEGIN ... ROLLBACK, because mon_003
-- cannot be exercised against real data (process-replies has never failed in 5,682 ticks):
--   old failure + newer OK run -> new 'Last run: ...'      old 'ZZZ_STALE_FAILURE...'
--   latest run failed          -> new shows the failure    (the useful case still works)
--   two failures               -> new shows most RECENT    old showed lexical max()
-- Zero synthetic rows leaked; the one genuine failed heartbeat is untouched.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- THE DEFECT
--
-- Both views computed their detail line as:
--
--     COALESCE(max(CASE WHEN ok = false THEN detail END),
--              'Last run: ' || to_char(max(ran_at), ...))
--
-- over EVERY heartbeat the job has ever written, with no recency bound. Two consequences,
-- and the second is the one that bit:
--
--   1. max() on text is LEXICAL, not most-recent. Of several failures it shows whichever
--      string sorts highest, which is unrelated to which happened last.
--   2. Once ANY failed run exists, the view shows a failure string FOREVER. The job can
--      recover and stay green indefinitely; the detail never changes back.
--
-- MEASURED ON 2026-08-27, before this migration:
--
--   instantly-poll has 1,894 heartbeats. Exactly ONE has ever failed, on 2026-08-23
--   21:15:03. Every tick for the four days since is ok = true. And mon_002 still rendered:
--
--     state:  OK
--     detail: Run failed: 2 error(s) ... campaign c0ffee00-0000-4000-a000-000000000001
--             external_id b1234567-mock-4000-a000-staging000001 has no Instantly
--             analytics row
--
-- That string outlived its cause by four days. It was still naming a mock campaign and a
-- mock external_id that had already been cleaned up, which is worse than showing nothing:
-- it sent a reader looking for a live fault that no longer existed.
--
-- BACKLOG predicted this exactly ("After the mock campaigns are cleaned, MON-002's detail
-- will keep displaying the mock external_id indefinitely") and it was right.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY MON-003 IS IN THE SAME MIGRATION
--
-- mon_003 is built from the identical template against job_name = 'process-replies'. It
-- currently renders a clean 'Last run: ...' line, but ONLY because process-replies has
-- never failed once in 5,681 heartbeats. It is one failed tick away from freezing in the
-- same way, permanently. Fixing the view that visibly broke and leaving its twin alone
-- would be fixing the symptom rather than the template.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT THIS MIGRATION DOES NOT CHANGE, DELIBERATELY
--
-- `state` still depends ONLY on how stale max(ran_at) is. It does not consult `ok`. So a
-- run that FAILS while still completing on time continues to report state = OK. That is a
-- second, separate defect, it is already recorded in BACKLOG, and changing it alters when
-- the monitor page goes red. It is a behavioural change to alerting and wants its own
-- decision, so it is deliberately out of scope here and remains open.
--
-- After this migration the failure is at least VISIBLE in the detail line of the run it
-- belongs to, instead of being frozen from an arbitrary run in the past.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- PRIVILEGES
--
-- CREATE OR REPLACE VIEW (not DROP + CREATE) so existing grants are PRESERVED. A
-- DROP + CREATE would lose them and Supabase's ALTER DEFAULT PRIVILEGES on the public
-- schema would immediately re-grant SELECT to anon and authenticated, silently
-- reopening exactly what 20260826170000_revoke_anon_on_views.sql closed.
--
-- The REVOKE/GRANT block below is therefore belt and braces, not the mechanism. It is
-- included because assuming the effect of a grant instead of reading it back is the
-- single most repeated mistake in this database's history.
--
-- security_invoker = true is SET here, which the previous migration did not do. Safe
-- because the only reader is the monitor sweep running as service_role
-- (src/app/api/cron/monitor-sweep/route.ts), and service_role has rolbypassrls = true,
-- verified live. The operator dashboard reads monitor_checks and monitor_events, not
-- these views. With security_invoker = true, RLS on cron_heartbeats is consulted for the
-- CALLER, so even if a future migration re-grants anon by accident, the view returns
-- nothing rather than handing over the base table.

CREATE OR REPLACE VIEW public.mon_002
WITH (security_invoker = true) AS
SELECT 'MON-002'::text AS check_code,
       CASE
         WHEN latest.ran_at IS NULL THEN 'UNKNOWN'
         WHEN EXTRACT(epoch FROM now() - latest.ran_at) / 60::numeric > 30::numeric THEN 'PROBLEM'
         ELSE 'OK'
       END::text AS state,
       COALESCE(
         CASE WHEN latest.ok = false THEN latest.detail END,
         'Last run: '::text || to_char(latest.ran_at, 'YYYY-MM-DD HH24:MI:SS UTC'::text)
       ) AS detail,
       latest.ran_at AS last_run
  FROM (SELECT 1) AS one(x)
  -- LEFT JOIN LATERAL so the view still returns exactly ONE row when the job has never
  -- run at all, matching the old aggregate's behaviour. A plain FROM ... LIMIT 1 would
  -- return zero rows there and the monitor sweep would read a missing check as absent
  -- rather than as UNKNOWN.
  LEFT JOIN LATERAL (
    SELECT h.ran_at, h.ok, h.detail
      FROM public.cron_heartbeats h
     WHERE h.job_name = 'instantly-poll'
     ORDER BY h.ran_at DESC
     LIMIT 1
  ) AS latest ON true;

CREATE OR REPLACE VIEW public.mon_003
WITH (security_invoker = true) AS
SELECT 'MON-003'::text AS check_code,
       CASE
         WHEN latest.ran_at IS NULL THEN 'UNKNOWN'
         WHEN EXTRACT(epoch FROM now() - latest.ran_at) / 60::numeric > 10::numeric THEN 'PROBLEM'
         ELSE 'OK'
       END::text AS state,
       COALESCE(
         CASE WHEN latest.ok = false THEN latest.detail END,
         'Last run: '::text || to_char(latest.ran_at, 'YYYY-MM-DD HH24:MI:SS UTC'::text)
       ) AS detail,
       latest.ran_at AS last_run
  FROM (SELECT 1) AS one(x)
  LEFT JOIN LATERAL (
    SELECT h.ran_at, h.ok, h.detail
      FROM public.cron_heartbeats h
     WHERE h.job_name = 'process-replies'
     ORDER BY h.ran_at DESC
     LIMIT 1
  ) AS latest ON true;

-- Re-assert the intended privileges and read them back after apply. Both directions:
-- the role that must have it, and the roles that must not.
REVOKE ALL ON public.mon_002 FROM PUBLIC;
REVOKE ALL ON public.mon_003 FROM PUBLIC;
REVOKE ALL ON public.mon_002 FROM anon, authenticated;
REVOKE ALL ON public.mon_003 FROM anon, authenticated;
GRANT SELECT ON public.mon_002 TO service_role;
GRANT SELECT ON public.mon_003 TO service_role;
