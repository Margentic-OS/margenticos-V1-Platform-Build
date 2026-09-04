-- MON-027: the reply poller's own alarm is finally read by something.
--
-- Status: PENDING (not yet applied)
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY THIS EXISTS
--
-- polling_cursors carries error_count and last_error. The poller's own comments call
-- last_error "the alarm". Measured 2026-09-04 against the live catalog: of the 23 mon_*
-- views in this database, ZERO read polling_cursors, and the only reader anywhere in src/
-- is the poller's own getCursor, which selects last_cursor and nothing else.
--
-- So for the life of the system those two columns have been WRITE-ONLY. Every failure the
-- poller does handle correctly — a page fetch that failed, a cursor that stopped advancing,
-- a bookkeeping write that errored — was recorded faithfully into a column nothing reads.
--
-- This is the same shape this codebase keeps producing, and the third instance written down:
-- the monitor sweep whose loop never reached mon_019, and the anon-privilege audit that
-- filtered relkind = 'r' and therefore never looked at a view. A check that runs, records
-- its answer, and has no reader is indistinguishable from a check that passes.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT MAKES IT RED, AND WHY THE STALL CLAUSE IS THE LOAD-BEARING ONE
--
--   error_count > 0        the poller recorded at least one failed call and no clean run
--                          has reset it since. Covers page-fetch failure, a non-advancing
--                          cursor, and (new in this commit) a signal row that failed to
--                          write.
--
--   stalled                'replies' has run since, but its last_cursor has not moved while
--                          last_error is set. This is the state the cursor-hold change in
--                          this same commit can now produce, and it is the reason that
--                          change is safe to make.
--
-- The poller now HOLDS the cursor when a signal row fails to write, instead of advancing
-- past the lost event. That converts a silent permanent loss into a visible stall. It is
-- the right trade only if something can see the stall. Without this monitor the new
-- behaviour would be as silent as the bug it replaces, just in the other direction.
-- The cursor-hold and this view ship in one commit for that reason. Do not remove either
-- half alone.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY UNKNOWN AND NOT OK WHEN THERE ARE NO ROWS
--
-- Every rule here passes vacuously over an empty polling_cursors. A monitor born green over
-- an empty set is a monitor that has never been tested, so an empty table reports UNKNOWN.
-- Same reasoning as MON-024 and MON-026.

CREATE OR REPLACE VIEW public.mon_027 AS
WITH cursors AS (
  SELECT
    resource,
    last_run_at,
    last_cursor,
    error_count,
    last_error,
    updated_at
  FROM public.polling_cursors
  WHERE source = 'instantly'
),
failing AS (
  SELECT count(*) AS n,
         min(resource) AS first_resource,
         min(last_error) AS first_error,
         sum(error_count) AS total_errors
  FROM cursors
  WHERE error_count > 0
),
-- A resource that has run recently, carries an error, and is the one resource that keeps a
-- cross-run cursor. That combination is the held-cursor stall.
stalled AS (
  SELECT count(*) AS n, min(resource) AS first_resource
  FROM cursors
  WHERE resource = 'replies'
    AND last_error IS NOT NULL
    AND last_run_at > now() - interval '2 hours'
)
SELECT
  'MON-027'::text AS check_code,
  CASE
    WHEN (SELECT count(*) FROM cursors) = 0 THEN 'UNKNOWN'
    WHEN (SELECT n FROM stalled) > 0 THEN 'PROBLEM'
    WHEN (SELECT n FROM failing) > 0 THEN 'PROBLEM'
    ELSE 'OK'
  END AS state,
  CASE
    WHEN (SELECT count(*) FROM cursors) = 0
      THEN 'No polling cursor rows exist, so there is nothing to evaluate. This is not a pass: '
        || 'it means the poller has never written its state for this source.'
    WHEN (SELECT n FROM stalled) > 0
      THEN 'The reply cursor is being HELD and is not advancing. Last error: '
        || COALESCE((SELECT last_error FROM cursors WHERE resource = 'replies'), 'none recorded')
        || '. Replies after the held page are not being read until this clears. This is the '
        || 'deliberate stall that replaces silent reply loss: the page is re-fetched every '
        || 'run and rows that already landed dedupe, so no data is lost while it is red.'
    WHEN (SELECT n FROM failing) > 0
      THEN (SELECT n FROM failing)::text || ' polling resource(s) carrying errors, '
        || (SELECT total_errors FROM failing)::text || ' failure(s) total since the last clean run. '
        || 'First: ' || COALESCE((SELECT first_resource FROM failing), '?') || ' — '
        || COALESCE((SELECT first_error FROM failing), 'no detail')
    ELSE 'All ' || (SELECT count(*) FROM cursors)::text
      || ' polling cursor(s) clean, no recorded errors.'
  END AS detail,
  (SELECT max(last_run_at) FROM cursors) AS last_run;

-- Service-role only, BOTH LAYERS, and by name. REVOKE FROM PUBLIC alone is a no-op on
-- Supabase: ALTER DEFAULT PRIVILEGES grants anon and authenticated EXPLICITLY at creation.
-- This view is owned by postgres and is not security_invoker, so a grant here would hand
-- anon the contents of polling_cursors regardless of RLS on the base table. That is exactly
-- how nine mon_* views ended up anon-readable.
REVOKE ALL ON public.mon_027 FROM PUBLIC;
REVOKE ALL ON public.mon_027 FROM anon, authenticated;
GRANT SELECT ON public.mon_027 TO service_role;

-- ── REGISTER THE CHECK ────────────────────────────────────────────────────────
-- A view with no monitor_checks row renders on the operator board as a bare code.
-- Registered in the same migration that creates the view; MON-027 is added to the MONITORS
-- pair list in the same commit.

INSERT INTO public.monitor_checks
  (code, title, description, category, tier, is_scheduled, expected_interval_minutes,
   plain_meaning, plain_impact, plain_action)
VALUES (
  'MON-027',
  'The reply poller is not stuck and is not swallowing errors',
  'Reads polling_cursors, which the poller writes and which nothing else has ever read. '
    || 'Goes red when any polling resource carries a recorded failure, and separately when '
    || 'the reply cursor is being held because a signal row failed to write. Returns UNKNOWN '
    || 'rather than OK when no cursor rows exist at all.',
  'data_integrity',
  1,
  false,
  NULL,

  'Replies are being read from the sending tool, and none are stuck. The poller remembers '
    || 'its place in the list of replies. This check watches that place: whether it is moving, '
    || 'and whether the poller has recorded a problem it could not get past.',

  'The poller used to move its place forward whenever it had successfully FETCHED a page, '
    || 'not when it had successfully SAVED the replies on it. A reply whose row failed to '
    || 'save was skipped, the place moved past it, and the reply was gone for good with no '
    || 'way to get it back short of editing the database by hand. Worse, that run then '
    || 'reported itself clean and reset the error count to zero. The poller now stops instead '
    || 'of skipping, and this check is what makes that stop visible. Without it the system '
    || 'would simply be quietly stuck instead of quietly losing replies.',

  'If the detail says the cursor is HELD: no replies are being lost while it is red, but no '
    || 'new replies are being read either, so treat it as urgent. Look up the failing event '
    || 'id named in the poller log and find out why its row will not save — a constraint '
    || 'violation on the signals table is the usual cause. Fix that and the next run drains '
    || 'the backlog on its own; replies that already saved are skipped automatically. If the '
    || 'detail instead lists failure counts, read the error text: a fetch failure that has '
    || 'stopped recurring clears itself on the next clean run. Never clear this by editing '
    || 'polling_cursors by hand: moving last_cursor forward is exactly how a reply gets lost.'
)
ON CONFLICT (code) DO UPDATE SET
  title                     = EXCLUDED.title,
  description               = EXCLUDED.description,
  category                  = EXCLUDED.category,
  tier                      = EXCLUDED.tier,
  is_scheduled              = EXCLUDED.is_scheduled,
  expected_interval_minutes = EXCLUDED.expected_interval_minutes,
  plain_meaning             = EXCLUDED.plain_meaning,
  plain_impact              = EXCLUDED.plain_impact,
  plain_action              = EXCLUDED.plain_action;
