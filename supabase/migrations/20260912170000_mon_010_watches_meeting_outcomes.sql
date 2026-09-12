-- Status: APPLIED (verified live 2026-09-12)
--   Read back BY CONTENT on both projects, not by name: the view definition contains
--   'meeting-outcomes' and no longer contains 'resolve-auto-held'.
--   Grants read back in BOTH directions on both: service_role SELECT true, anon false,
--   authenticated false.
--   Production reports UNKNOWN :: "meeting-outcomes has never reported. Check the pg_cron job
--   exists and is active." Correct until 20260912160000 is applied after the merge.
--   The six mon_010 tests in monitor_state_latest_run.test.ts pass again: 22/22 in that file.
--
-- mon_010 watches the meeting-outcomes job instead of the deleted resolve-auto-held. ADR-057.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY THIS IS ITS OWN FILE
--
-- It was part of 20260912160000, which also SCHEDULES the new pg_cron job. That file cannot be
-- applied until after the merge, because the job command needs the real CRON_SECRET (never
-- committed) and the route it calls does not exist on production yet.
--
-- This half needs no secret and depends on no deployed code: it is a view over
-- cron_heartbeats. Bundling it with the half that must wait meant the live view kept reading
-- the heartbeat of a job that no longer exists, while the code and its tests had moved on.
-- Six tests in monitor_state_latest_run.test.ts failed on exactly that disagreement, which is
-- the "migrations land before code" rule pointing the other way: a migration held back can
-- strand the code that expects it just as surely as one applied too early.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT IT REPORTS BETWEEN NOW AND THE JOB EXISTING
--
-- UNKNOWN, with the detail "meeting-outcomes has never reported. Check the pg_cron job exists
-- and is active." That is TRUE and actionable, and it is strictly better than the alternative:
-- left pointing at resolve-auto-held, mon_010 would have gone PROBLEM about 25 hours after
-- that job was paused and blamed a job we deliberately switched off.
--
-- THE FORMAT CONTRACT IS UNCHANGED. It still parses the organisation count out of
-- "Examined N organisations" and compares it against the organisations that existed at run
-- time, so a run reporting success over work it did not do is a PROBLEM whatever its own `ok`
-- said. The new route writes that same prefix deliberately, and route.test.ts asserts it.

CREATE OR REPLACE VIEW public.mon_010 AS
SELECT 'MON-010'::text AS check_code,
       CASE
         WHEN ran_at IS NULL THEN 'UNKNOWN'::text
         WHEN (EXTRACT(epoch FROM now() - ran_at) / 60::numeric) > 1500::numeric THEN 'PROBLEM'::text
         WHEN ok = false THEN 'PROBLEM'::text
         WHEN examined IS NULL THEN 'UNKNOWN'::text
         WHEN examined < org_count THEN 'PROBLEM'::text
         ELSE 'OK'::text
       END AS state,
       CASE
         WHEN ran_at IS NULL THEN 'meeting-outcomes has never reported. Check the pg_cron job exists and is active.'::text
         WHEN (EXTRACT(epoch FROM now() - ran_at) / 60::numeric) > 1500::numeric
           THEN 'Last run '::text || to_char(ran_at, 'YYYY-MM-DD HH24:MI:SS UTC'::text) || ', over 1500 minutes ago.'::text
         WHEN ok = false THEN 'Last run FAILED: '::text || COALESCE(detail, 'no detail'::text)
         WHEN examined IS NULL
           THEN 'Cannot verify. Heartbeat detail does not match the expected "Examined N organisations" format, so the organisation cross-check could not run. Reporting UNKNOWN rather than OK. Detail was: '::text || COALESCE(detail, 'no detail'::text)
         WHEN examined < org_count
           THEN 'Run reported ok but examined only '::text || examined::text || ' organisation(s) while '::text || org_count::text || ' existed at '::text || to_char(ran_at, 'YYYY-MM-DD HH24:MI:SS UTC'::text) || '. The job is reporting success over work it did not do. Check the cron is using a service-role client: this is exactly how resolve-auto-held ran as anon for a month.'::text
         ELSE 'Last run OK: '::text || COALESCE(detail, to_char(ran_at, 'YYYY-MM-DD HH24:MI:SS UTC'::text)) || ' (cross-checked against '::text || org_count::text || ' organisation(s) live at run time)'::text
       END AS detail,
       ran_at AS last_run
  FROM (
    SELECT latest.ran_at,
           latest.ok,
           latest.detail,
           "substring"(latest.detail, '^Examined ([0-9]+) organisations'::text)::bigint AS examined,
           COALESCE((SELECT count(*) FROM organisations o
                      WHERE o.archived_at IS NULL AND o.created_at <= latest.ran_at), 0::bigint) AS org_count
      FROM (SELECT 1) one
      LEFT JOIN LATERAL (
        SELECT h.ran_at, h.ok, h.detail
          FROM cron_heartbeats h
         WHERE h.job_name = 'meeting-outcomes'::text
         ORDER BY h.ran_at DESC, h.id DESC
         LIMIT 1
      ) latest ON true
  ) p;

-- CREATE OR REPLACE keeps the view's existing options and privileges. The grants are asserted
-- explicitly anyway, because assuming the effect of a grant instead of reading it back is the
-- mistake behind three separate incidents in this database. mon_010 was one of the nine
-- anon-readable monitoring views found on 2026-08-26.
REVOKE ALL ON TABLE public.mon_010 FROM PUBLIC;
REVOKE ALL ON TABLE public.mon_010 FROM anon, authenticated;
GRANT SELECT ON TABLE public.mon_010 TO service_role;
