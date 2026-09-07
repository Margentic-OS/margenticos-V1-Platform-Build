-- 20260907180000_mon_010_cross_check_organisation_count.sql
--
-- Status: PENDING (apply via MCP apply_migration, then verify live and stamp APPLIED)
--
-- MON-010 STOPS TRUSTING THE JOB'S OWN SELF-REPORT.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- WHY
--
-- resolve-auto-held ran as `anon` from 2026-08-09 to 2026-09-07 because its route
-- built a service-role client and then called the resolver without passing it. The
-- resolver caught its own denied read and returned an empty array, so the route wrote
-- ok = true with the detail 'Processed 0 organisations, resolved 0 meetings'.
--
-- Measured: 31 consecutive heartbeats, 31 ok = true, ONE distinct detail string,
-- while three live non-archived organisations existed the whole time.
--
-- MON-010 read exactly two signals: heartbeat freshness, and `ok`. Both were written
-- by the code path that had already swallowed the error. The monitor sat DOWNSTREAM
-- of the defect, so it could not have caught it at any point in those 31 days. It
-- showed OK on the board while the job that decides what gets invoiced did nothing.
--
-- This is the shape CLAUDE.md keeps returning to: when the check is the thing that is
-- wrong, nothing downstream of it can notice. Same family as the audit query that
-- filtered relkind = 'r', and the monitor sweep whose loop was bounded by the shorter
-- of two arrays.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- WHAT CHANGES
--
-- The view now reads THE WORLD as well as the report. It counts the organisations
-- that actually existed when the run happened and compares that against the number
-- the run says it examined. Zero examined while three exist is a PROBLEM whatever
-- `ok` says.
--
-- Applied to the outage above, this fires on the FIRST bad run, 2026-08-09, not on
-- the day somebody happened to read Sentry.
--
-- Precedent: mon_017 and mon_018 already ignore the heartbeat and read the job
-- queue's real contents. This is that shape, applied to a job whose real contents
-- live in another table.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- THE COUNT IS TAKEN AS AT THE RUN, NOT AS AT NOW
--
-- `created_at <= latest.ran_at` matters. An organisation created after the run
-- legitimately was not examined by it, and comparing against a bare live count would
-- report PROBLEM every time a client is onboarded, until the next daily run cleared
-- it. A monitor that cries wolf on a normal event teaches the operator to ignore the
-- board, which is how MON-007 had to be retired.
--
-- The reverse race is harmless: an organisation archived after the run was examined
-- but is no longer counted, giving examined > expected, which is not a failure state.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- IT REPORTS UNKNOWN RATHER THAN OK WHEN IT CANNOT PARSE
--
-- The cross-check reads the integer out of the detail string, anchored on
-- '^Examined (N) organisations'. That format is written by
-- src/app/api/cron/resolve-auto-held/route.ts and the two are committed together.
--
-- If the string ever stops matching, this view reports UNKNOWN, never OK. A check
-- that cannot perform its comparison must not report the colour that means "I
-- compared and it was fine" — that is the vacuous pass this project has been bitten
-- by more than once. MON-028 and MON-031 already take this position.
--
-- The old wording 'Processed N organisations' is deliberately NOT accepted. It could
-- not distinguish organisations WALKED from organisations that had work to do, so it
-- read 0 on a healthy empty run and 0 on a denied read. Any heartbeat still carrying
-- it is a pre-fix row and should surface as UNKNOWN rather than be silently parsed.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- IT ALWAYS RETURNS EXACTLY ONE ROW
--
-- The LEFT JOIN LATERAL against a one-row anchor is load-bearing and is kept from the
-- previous definition. A plain CTE chain off cron_heartbeats returns ZERO ROWS when the
-- job has never reported, and a monitor that returns no row reads to the sweep as a
-- monitor that is absent rather than one that is complaining. The never-reported case
-- is precisely when this check matters most, so it must yield an UNKNOWN row.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW public.mon_010 AS
SELECT
  'MON-010'::text AS check_code,
  CASE
    WHEN p.ran_at IS NULL THEN 'UNKNOWN'
    WHEN EXTRACT(EPOCH FROM (now() - p.ran_at)) / 60 > 1500 THEN 'PROBLEM'
    WHEN p.ok = false THEN 'PROBLEM'
    WHEN p.examined IS NULL THEN 'UNKNOWN'
    WHEN p.examined < p.org_count THEN 'PROBLEM'
    ELSE 'OK'
  END AS state,
  CASE
    WHEN p.ran_at IS NULL
      THEN 'resolve-auto-held has never reported. Check the pg_cron job exists and is active.'
    WHEN EXTRACT(EPOCH FROM (now() - p.ran_at)) / 60 > 1500
      THEN 'Last run ' || TO_CHAR(p.ran_at, 'YYYY-MM-DD HH24:MI:SS UTC') || ', over 1500 minutes ago.'
    WHEN p.ok = false
      THEN 'Last run FAILED: ' || COALESCE(p.detail, 'no detail')
    WHEN p.examined IS NULL
      THEN 'Cannot verify. Heartbeat detail does not match the expected '
           || '"Examined N organisations" format, so the organisation cross-check could '
           || 'not run. Reporting UNKNOWN rather than OK. Detail was: '
           || COALESCE(p.detail, 'no detail')
    WHEN p.examined < p.org_count
      THEN 'Run reported ok but examined only ' || p.examined::text
           || ' organisation(s) while ' || p.org_count::text
           || ' existed at ' || TO_CHAR(p.ran_at, 'YYYY-MM-DD HH24:MI:SS UTC')
           || '. The job is reporting success over work it did not do. Check the cron is '
           || 'using a service-role client: this is exactly how it ran as anon for a month.'
    ELSE 'Last run OK: ' || COALESCE(p.detail, TO_CHAR(p.ran_at, 'YYYY-MM-DD HH24:MI:SS UTC'))
         || ' (cross-checked against ' || p.org_count::text
         || ' organisation(s) live at run time)'
  END AS detail,
  p.ran_at AS last_run
FROM (
  SELECT
    latest.ran_at,
    latest.ok,
    latest.detail,
    -- NULL when the detail does not match the format this view was written against.
    (substring(latest.detail FROM '^Examined ([0-9]+) organisations'))::bigint AS examined,
    -- Organisations as at the RUN, not as at now. See the note above.
    COALESCE((
      SELECT count(*)
        FROM public.organisations o
       WHERE o.archived_at IS NULL
         AND o.created_at <= latest.ran_at
    ), 0)::bigint AS org_count
  FROM (SELECT 1) one
  LEFT JOIN LATERAL (
    SELECT h.ran_at, h.ok, h.detail
      FROM public.cron_heartbeats h
     WHERE h.job_name = 'resolve-auto-held'
     ORDER BY h.ran_at DESC, h.id DESC
     LIMIT 1
  ) latest ON true
) p;


-- ═════════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The definition below is the EXACT prior definition, captured verbatim from
-- pg_get_viewdef('public.mon_010'::regclass, true) against production on
-- 2026-09-07 before this migration was written. Restoring it returns MON-010 to
-- reading the job's self-report alone, which is the state that could not see a
-- month-long outage. Roll back only to unblock, and re-apply.
--
-- CREATE OR REPLACE VIEW public.mon_010 AS
--   SELECT 'MON-010'::text AS check_code,
--     CASE
--       WHEN latest.ran_at IS NULL THEN 'UNKNOWN'::text
--       WHEN (EXTRACT(epoch FROM now() - latest.ran_at) / 60::numeric) > 1500::numeric THEN 'PROBLEM'::text
--       WHEN latest.ok = false THEN 'PROBLEM'::text
--       ELSE 'OK'::text
--     END AS state,
--     CASE
--       WHEN latest.ran_at IS NULL THEN 'resolve-auto-held has never reported. Check the pg_cron job exists and is active.'::text
--       WHEN (EXTRACT(epoch FROM now() - latest.ran_at) / 60::numeric) > 1500::numeric THEN ('Last run '::text || to_char(latest.ran_at, 'YYYY-MM-DD HH24:MI:SS UTC'::text)) || ', over 1500 minutes ago.'::text
--       WHEN latest.ok = false THEN 'Last run FAILED: '::text || COALESCE(latest.detail, 'no detail'::text)
--       ELSE 'Last run OK: '::text || COALESCE(latest.detail, to_char(latest.ran_at, 'YYYY-MM-DD HH24:MI:SS UTC'::text))
--     END AS detail,
--     latest.ran_at AS last_run
--    FROM ( SELECT 1 AS "?column?") one
--      LEFT JOIN LATERAL ( SELECT h.ran_at, h.ok, h.detail
--            FROM cron_heartbeats h
--           WHERE h.job_name = 'resolve-auto-held'::text
--           ORDER BY h.ran_at DESC, h.id DESC
--          LIMIT 1) latest ON true;
