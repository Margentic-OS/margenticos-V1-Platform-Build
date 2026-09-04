-- Migration: six liveness monitors now read whether the LATEST run succeeded
-- Status: APPLIED (verified live 2026-09-04, production and test project)
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE DEFECT
-- ─────────────────────────────────────────────────────────────────────────────
--
-- mon_001, mon_002, mon_003, mon_004, mon_005 and mon_010 derived their state
-- from staleness ALONE:
--
--     CASE
--       WHEN max(ran_at) IS NULL                          THEN 'UNKNOWN'
--       WHEN (now() - max(ran_at)) > <threshold> minutes   THEN 'PROBLEM'
--       ELSE 'OK'                                          -- <- the drop
--     END
--
-- cron_heartbeats.ok was selected and read into the DETAIL string, and never
-- into the STATE. So a job that runs exactly on schedule and fails every single
-- run reported OK. A silent monitor reads on the board as a healthy one, which
-- makes this a defect that hides defects.
--
-- MEASURED, not reasoned about. On 2026-09-03 the monitor sweep itself failed
-- five consecutive runs, writing ok=false with detail "Checked 21 monitors,
-- 1 error(s)". MON-005, the monitor that watches the sweep, reported OK for the
-- whole hour. The monitor watching the monitors went green while it was broken.
--
-- The sweep route has documented this defect in its own header comment since the
-- queue monitors were built, as a contrast against mon_016. It was described and
-- not fixed.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE SECOND DEFECT, IN THE SAME SIX VIEWS: A DETAIL LINE FROZEN FOR EVER
-- ─────────────────────────────────────────────────────────────────────────────
--
-- mon_001, mon_004, mon_005 and mon_010 built detail as:
--
--     COALESCE(max(CASE WHEN ok = false THEN detail END), 'Last run: ' || ...)
--
-- That max() has NO TIME WINDOW. It is the alphabetically largest failure
-- message from all of history, so one bad run poisons the detail line for ever,
-- long after recovery. Read live on 2026-09-04, MON-005 showed state OK beside
-- detail "Checked 21 monitors, 1 error(s)", a message from the previous day that
-- no longer described anything. A green state next to a red sentence is two
-- wrong answers, not one.
--
-- Both defects have the same root: the state and the detail were computed from
-- DIFFERENT rows. Every view below now resolves ONE latest heartbeat and derives
-- state, detail and last_run from that single row, so they cannot disagree.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE SHAPE, AND WHY THIS ONE
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Two correct shapes already existed in this database:
--
--   mon_016          WHEN latest.ok = false THEN 'PROBLEM'
--                    "did the latest run fail". Red on the next failure, green
--                    on the next success.
--
--   mon_019/020/021  bool_or(NOT ok) FILTER (WHERE ran_at > now() - interval)
--                    "did any run fail in a window". Stickier, and stays red for
--                    the whole window after recovery.
--
-- These six take mon_016's shape. Green then means "working right now", which is
-- the least surprising thing a board can mean, and it is exactly the property the
-- defect removed. The window shape is deliberately NOT applied here: mon_019,
-- mon_020 and mon_021 keep theirs and are untouched by this migration, and
-- MON-018 already covers the flapping case by reading terminal job outcomes
-- rather than heartbeats.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- TWO PROPERTIES THAT MUST NOT BE LOST
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 1. EXACTLY ONE ROW, ALWAYS. The sweep calls .single() on each view, which
--    ERRORS on zero rows and would be counted as a failed check rather than as
--    UNKNOWN. The bare aggregates being replaced returned one row even with no
--    heartbeats at all. A plain "SELECT ... FROM latest" would return NO rows in
--    that case and break the sweep for any job that has never run. Hence the
--    "FROM (SELECT 1) one LEFT JOIN LATERAL (...) latest ON true" below, which is
--    the pattern mon_002 and mon_003 already used. Do not simplify it away.
--
-- 2. THE COLUMN LIST. check_code, state, detail, last_run, in that order. The
--    sweep selects check_code, state and detail by name.
--
-- CREATE OR REPLACE VIEW preserves ownership and existing grants, so this
-- migration changes no privileges. Verified by reading them back after applying.
--
-- The job_name literals below ('instantly-poll' and the rest) are pre-existing
-- values in cron_heartbeats.job_name that these views already filtered on. They
-- are data, not new vendor references, and changing one would silently detach a
-- monitor from the job it watches.
--
-- Also added, in every view: "ORDER BY ran_at DESC, id DESC". Two heartbeats
-- sharing a ran_at previously resolved arbitrarily. mon_016 already tie-breaks on
-- id; these now match it, so "the latest run" is a defined row rather than a
-- coin toss.


-- ──────────────────────────────────────────────────────────────────────────────
-- MON-001: auto-approve, hourly, stale after 75 minutes
-- ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.mon_001 AS
  SELECT
    'MON-001'::text AS check_code,
    CASE
      WHEN latest.ran_at IS NULL THEN 'UNKNOWN'
      WHEN EXTRACT(EPOCH FROM (now() - latest.ran_at)) / 60 > 75 THEN 'PROBLEM'
      WHEN latest.ok = false THEN 'PROBLEM'
      ELSE 'OK'
    END AS state,
    CASE
      WHEN latest.ran_at IS NULL
        THEN 'auto-approve has never reported. Check the pg_cron job exists and is active.'
      WHEN EXTRACT(EPOCH FROM (now() - latest.ran_at)) / 60 > 75
        THEN 'Last run ' || TO_CHAR(latest.ran_at, 'YYYY-MM-DD HH24:MI:SS UTC') || ', over 75 minutes ago.'
      WHEN latest.ok = false
        THEN 'Last run FAILED: ' || COALESCE(latest.detail, 'no detail')
      ELSE 'Last run OK: ' || COALESCE(latest.detail, TO_CHAR(latest.ran_at, 'YYYY-MM-DD HH24:MI:SS UTC'))
    END AS detail,
    latest.ran_at AS last_run
  FROM (SELECT 1) one
  LEFT JOIN LATERAL (
    SELECT h.ran_at, h.ok, h.detail
      FROM public.cron_heartbeats h
     WHERE h.job_name = 'auto-approve'
     ORDER BY h.ran_at DESC, h.id DESC
     LIMIT 1
  ) latest ON true;


-- ──────────────────────────────────────────────────────────────────────────────
-- MON-002: instantly-poll, every 15 minutes, stale after 30
-- ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.mon_002 AS
  SELECT
    'MON-002'::text AS check_code,
    CASE
      WHEN latest.ran_at IS NULL THEN 'UNKNOWN'
      WHEN EXTRACT(EPOCH FROM (now() - latest.ran_at)) / 60 > 30 THEN 'PROBLEM'
      WHEN latest.ok = false THEN 'PROBLEM'
      ELSE 'OK'
    END AS state,
    CASE
      WHEN latest.ran_at IS NULL
        THEN 'instantly-poll has never reported. Check the pg_cron job exists and is active.'
      WHEN EXTRACT(EPOCH FROM (now() - latest.ran_at)) / 60 > 30
        THEN 'Last run ' || TO_CHAR(latest.ran_at, 'YYYY-MM-DD HH24:MI:SS UTC') || ', over 30 minutes ago.'
      WHEN latest.ok = false
        THEN 'Last run FAILED: ' || COALESCE(latest.detail, 'no detail')
      ELSE 'Last run OK: ' || COALESCE(latest.detail, TO_CHAR(latest.ran_at, 'YYYY-MM-DD HH24:MI:SS UTC'))
    END AS detail,
    latest.ran_at AS last_run
  FROM (SELECT 1) one
  LEFT JOIN LATERAL (
    SELECT h.ran_at, h.ok, h.detail
      FROM public.cron_heartbeats h
     WHERE h.job_name = 'instantly-poll'
     ORDER BY h.ran_at DESC, h.id DESC
     LIMIT 1
  ) latest ON true;


-- ──────────────────────────────────────────────────────────────────────────────
-- MON-003: process-replies, every 5 minutes, stale after 10
-- ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.mon_003 AS
  SELECT
    'MON-003'::text AS check_code,
    CASE
      WHEN latest.ran_at IS NULL THEN 'UNKNOWN'
      WHEN EXTRACT(EPOCH FROM (now() - latest.ran_at)) / 60 > 10 THEN 'PROBLEM'
      WHEN latest.ok = false THEN 'PROBLEM'
      ELSE 'OK'
    END AS state,
    CASE
      WHEN latest.ran_at IS NULL
        THEN 'process-replies has never reported. Check the pg_cron job exists and is active.'
      WHEN EXTRACT(EPOCH FROM (now() - latest.ran_at)) / 60 > 10
        THEN 'Last run ' || TO_CHAR(latest.ran_at, 'YYYY-MM-DD HH24:MI:SS UTC') || ', over 10 minutes ago.'
      WHEN latest.ok = false
        THEN 'Last run FAILED: ' || COALESCE(latest.detail, 'no detail')
      ELSE 'Last run OK: ' || COALESCE(latest.detail, TO_CHAR(latest.ran_at, 'YYYY-MM-DD HH24:MI:SS UTC'))
    END AS detail,
    latest.ran_at AS last_run
  FROM (SELECT 1) one
  LEFT JOIN LATERAL (
    SELECT h.ran_at, h.ok, h.detail
      FROM public.cron_heartbeats h
     WHERE h.job_name = 'process-replies'
     ORDER BY h.ran_at DESC, h.id DESC
     LIMIT 1
  ) latest ON true;


-- ──────────────────────────────────────────────────────────────────────────────
-- MON-004: reap-agent-runs, every 10 minutes, stale after 20
-- ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.mon_004 AS
  SELECT
    'MON-004'::text AS check_code,
    CASE
      WHEN latest.ran_at IS NULL THEN 'UNKNOWN'
      WHEN EXTRACT(EPOCH FROM (now() - latest.ran_at)) / 60 > 20 THEN 'PROBLEM'
      WHEN latest.ok = false THEN 'PROBLEM'
      ELSE 'OK'
    END AS state,
    CASE
      WHEN latest.ran_at IS NULL
        THEN 'reap-agent-runs has never reported. Check the pg_cron job exists and is active.'
      WHEN EXTRACT(EPOCH FROM (now() - latest.ran_at)) / 60 > 20
        THEN 'Last run ' || TO_CHAR(latest.ran_at, 'YYYY-MM-DD HH24:MI:SS UTC') || ', over 20 minutes ago.'
      WHEN latest.ok = false
        THEN 'Last run FAILED: ' || COALESCE(latest.detail, 'no detail')
      ELSE 'Last run OK: ' || COALESCE(latest.detail, TO_CHAR(latest.ran_at, 'YYYY-MM-DD HH24:MI:SS UTC'))
    END AS detail,
    latest.ran_at AS last_run
  FROM (SELECT 1) one
  LEFT JOIN LATERAL (
    SELECT h.ran_at, h.ok, h.detail
      FROM public.cron_heartbeats h
     WHERE h.job_name = 'reap-agent-runs'
     ORDER BY h.ran_at DESC, h.id DESC
     LIMIT 1
  ) latest ON true;


-- ──────────────────────────────────────────────────────────────────────────────
-- MON-005: monitor-sweep, every 15 minutes, stale after 30
--
-- This is the one that proved the defect. It watches the sweep that reads every
-- other monitor, so when it lies, nothing downstream can notice.
-- ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.mon_005 AS
  SELECT
    'MON-005'::text AS check_code,
    CASE
      WHEN latest.ran_at IS NULL THEN 'UNKNOWN'
      WHEN EXTRACT(EPOCH FROM (now() - latest.ran_at)) / 60 > 30 THEN 'PROBLEM'
      WHEN latest.ok = false THEN 'PROBLEM'
      ELSE 'OK'
    END AS state,
    CASE
      WHEN latest.ran_at IS NULL
        THEN 'monitor-sweep has never reported. Check the pg_cron job exists and is active.'
      WHEN EXTRACT(EPOCH FROM (now() - latest.ran_at)) / 60 > 30
        THEN 'Last run ' || TO_CHAR(latest.ran_at, 'YYYY-MM-DD HH24:MI:SS UTC') || ', over 30 minutes ago.'
      WHEN latest.ok = false
        THEN 'Last run FAILED: ' || COALESCE(latest.detail, 'no detail')
      ELSE 'Last run OK: ' || COALESCE(latest.detail, TO_CHAR(latest.ran_at, 'YYYY-MM-DD HH24:MI:SS UTC'))
    END AS detail,
    latest.ran_at AS last_run
  FROM (SELECT 1) one
  LEFT JOIN LATERAL (
    SELECT h.ran_at, h.ok, h.detail
      FROM public.cron_heartbeats h
     WHERE h.job_name = 'monitor-sweep'
     ORDER BY h.ran_at DESC, h.id DESC
     LIMIT 1
  ) latest ON true;


-- ──────────────────────────────────────────────────────────────────────────────
-- MON-010: resolve-auto-held, daily, stale after 1500 minutes
-- ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.mon_010 AS
  SELECT
    'MON-010'::text AS check_code,
    CASE
      WHEN latest.ran_at IS NULL THEN 'UNKNOWN'
      WHEN EXTRACT(EPOCH FROM (now() - latest.ran_at)) / 60 > 1500 THEN 'PROBLEM'
      WHEN latest.ok = false THEN 'PROBLEM'
      ELSE 'OK'
    END AS state,
    CASE
      WHEN latest.ran_at IS NULL
        THEN 'resolve-auto-held has never reported. Check the pg_cron job exists and is active.'
      WHEN EXTRACT(EPOCH FROM (now() - latest.ran_at)) / 60 > 1500
        THEN 'Last run ' || TO_CHAR(latest.ran_at, 'YYYY-MM-DD HH24:MI:SS UTC') || ', over 1500 minutes ago.'
      WHEN latest.ok = false
        THEN 'Last run FAILED: ' || COALESCE(latest.detail, 'no detail')
      ELSE 'Last run OK: ' || COALESCE(latest.detail, TO_CHAR(latest.ran_at, 'YYYY-MM-DD HH24:MI:SS UTC'))
    END AS detail,
    latest.ran_at AS last_run
  FROM (SELECT 1) one
  LEFT JOIN LATERAL (
    SELECT h.ran_at, h.ok, h.detail
      FROM public.cron_heartbeats h
     WHERE h.job_name = 'resolve-auto-held'
     ORDER BY h.ran_at DESC, h.id DESC
     LIMIT 1
  ) latest ON true;


-- ═════════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The six definitions below are the EXACT prior definitions, captured verbatim
-- from pg_get_viewdef(oid, true) against production at 2026-09-04 19:02:29 UTC,
-- BEFORE this migration was written. They are not reconstructed from memory.
--
-- They are kept as a COMMENT and deliberately not as a separate migration file:
-- a runnable down-migration sitting in supabase/migrations/ would be applied by
-- any ordered replay and would silently revert this fix. That is the same
-- silent-revert shape MON-025 exists to catch.
--
-- To roll back: uncomment this block into a new migration and apply it. No table
-- is altered by either direction, so no data can be lost, and CREATE OR REPLACE
-- VIEW is atomic, so there is no window where a view does not exist.
--
-- -- mon_001 (captured live 2026-09-04 19:02:29 UTC)
-- CREATE OR REPLACE VIEW public.mon_001 AS
--  SELECT 'MON-001'::text AS check_code,
--         CASE
--             WHEN max(ran_at) IS NULL THEN 'UNKNOWN'::text
--             WHEN (EXTRACT(epoch FROM now() - max(ran_at)) / 60::numeric) > 75::numeric THEN 'PROBLEM'::text
--             ELSE 'OK'::text
--         END AS state,
--     COALESCE(max(
--         CASE
--             WHEN ok = false THEN detail
--             ELSE NULL::text
--         END), 'Last run: '::text || to_char(max(ran_at), 'YYYY-MM-DD HH24:MI:SS UTC'::text)) AS detail,
--     max(ran_at) AS last_run
--    FROM cron_heartbeats
--   WHERE job_name = 'auto-approve'::text;
--
-- -- mon_002 (captured live 2026-09-04 19:02:29 UTC)
-- CREATE OR REPLACE VIEW public.mon_002 AS
--  SELECT 'MON-002'::text AS check_code,
--         CASE
--             WHEN latest.ran_at IS NULL THEN 'UNKNOWN'::text
--             WHEN (EXTRACT(epoch FROM now() - latest.ran_at) / 60::numeric) > 30::numeric THEN 'PROBLEM'::text
--             ELSE 'OK'::text
--         END AS state,
--     COALESCE(
--         CASE
--             WHEN latest.ok = false THEN latest.detail
--             ELSE NULL::text
--         END, 'Last run: '::text || to_char(latest.ran_at, 'YYYY-MM-DD HH24:MI:SS UTC'::text)) AS detail,
--     latest.ran_at AS last_run
--    FROM ( SELECT 1 AS "?column?") one(x)
--      LEFT JOIN LATERAL ( SELECT h.ran_at,
--             h.ok,
--             h.detail
--            FROM cron_heartbeats h
--           WHERE h.job_name = 'instantly-poll'::text
--           ORDER BY h.ran_at DESC
--          LIMIT 1) latest ON true;
--
-- -- mon_003 (captured live 2026-09-04 19:02:29 UTC)
-- CREATE OR REPLACE VIEW public.mon_003 AS
--  SELECT 'MON-003'::text AS check_code,
--         CASE
--             WHEN latest.ran_at IS NULL THEN 'UNKNOWN'::text
--             WHEN (EXTRACT(epoch FROM now() - latest.ran_at) / 60::numeric) > 10::numeric THEN 'PROBLEM'::text
--             ELSE 'OK'::text
--         END AS state,
--     COALESCE(
--         CASE
--             WHEN latest.ok = false THEN latest.detail
--             ELSE NULL::text
--         END, 'Last run: '::text || to_char(latest.ran_at, 'YYYY-MM-DD HH24:MI:SS UTC'::text)) AS detail,
--     latest.ran_at AS last_run
--    FROM ( SELECT 1 AS "?column?") one(x)
--      LEFT JOIN LATERAL ( SELECT h.ran_at,
--             h.ok,
--             h.detail
--            FROM cron_heartbeats h
--           WHERE h.job_name = 'process-replies'::text
--           ORDER BY h.ran_at DESC
--          LIMIT 1) latest ON true;
--
-- -- mon_004 (captured live 2026-09-04 19:02:29 UTC)
-- CREATE OR REPLACE VIEW public.mon_004 AS
--  SELECT 'MON-004'::text AS check_code,
--         CASE
--             WHEN max(ran_at) IS NULL THEN 'UNKNOWN'::text
--             WHEN (EXTRACT(epoch FROM now() - max(ran_at)) / 60::numeric) > 20::numeric THEN 'PROBLEM'::text
--             ELSE 'OK'::text
--         END AS state,
--     COALESCE(max(
--         CASE
--             WHEN ok = false THEN detail
--             ELSE NULL::text
--         END), 'Last run: '::text || to_char(max(ran_at), 'YYYY-MM-DD HH24:MI:SS UTC'::text)) AS detail,
--     max(ran_at) AS last_run
--    FROM cron_heartbeats
--   WHERE job_name = 'reap-agent-runs'::text;
--
-- -- mon_005 (captured live 2026-09-04 19:02:29 UTC)
-- CREATE OR REPLACE VIEW public.mon_005 AS
--  SELECT 'MON-005'::text AS check_code,
--         CASE
--             WHEN max(ran_at) IS NULL THEN 'UNKNOWN'::text
--             WHEN (EXTRACT(epoch FROM now() - max(ran_at)) / 60::numeric) > 30::numeric THEN 'PROBLEM'::text
--             ELSE 'OK'::text
--         END AS state,
--     COALESCE(max(
--         CASE
--             WHEN ok = false THEN detail
--             ELSE NULL::text
--         END), 'Last run: '::text || to_char(max(ran_at), 'YYYY-MM-DD HH24:MI:SS UTC'::text)) AS detail,
--     max(ran_at) AS last_run
--    FROM cron_heartbeats
--   WHERE job_name = 'monitor-sweep'::text;
--
-- -- mon_010 (captured live 2026-09-04 19:02:29 UTC)
-- CREATE OR REPLACE VIEW public.mon_010 AS
--  SELECT 'MON-010'::text AS check_code,
--         CASE
--             WHEN max(ran_at) IS NULL THEN 'UNKNOWN'::text
--             WHEN (EXTRACT(epoch FROM now() - max(ran_at)) / 60::numeric) > 1500::numeric THEN 'PROBLEM'::text
--             ELSE 'OK'::text
--         END AS state,
--     COALESCE(max(
--         CASE
--             WHEN ok = false THEN detail
--             ELSE NULL::text
--         END), 'Last run: '::text || to_char(max(ran_at), 'YYYY-MM-DD HH24:MI:SS UTC'::text)) AS detail,
--     max(ran_at) AS last_run
--    FROM cron_heartbeats
--   WHERE job_name = 'resolve-auto-held'::text;
