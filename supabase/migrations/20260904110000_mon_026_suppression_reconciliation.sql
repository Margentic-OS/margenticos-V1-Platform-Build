-- MON-026: nobody our database says must not be mailed is still being mailed.
--
-- Status: APPLIED (verified live 2026-09-04; production. The test project gets the table
-- and the view but NOT the cron: it has no queue-worker job to copy the authorised
-- command from, and nothing there calls the route.)
--
-- Read-back after apply, production:
--   mon_026 -> UNKNOWN, "No suppression reconciliation has run yet." Correct before the
--             first firing, and it is UNKNOWN rather than OK, which is the point.
--   cron.job suppression-reconcile: */30 * * * *, active.
--   mon_025 still OK, now "All 12 declared job(s)...", so the new job is declared.
--   suppression_reconciliation_snapshot  anon/authenticated SELECT: false. service_role: true.
--   mon_026                              anon/authenticated SELECT: false. service_role: true.
--
-- FIRST LIVE RUN, 2026-09-04, after the write paths were fixed:
--   26 uploaded, 6 suppressed, 6 read back from the provider,
--   0 unreconciled, 0 unreachable, 0 invariant breaches.
--
-- The FIRST live run reported 2 unreachable, and investigating them changed the sweep. See
-- judgeProspect in src/lib/suppression/reconcile.ts: neither was a provider that could not
-- be reached. One lead had been deleted with its campaign in August, and one row carried a
-- MOCK lead id written by an upload made while the provider flag was off. The sweep now
-- falls back from the stored id to the ADDRESS, which is the authoritative question.
--
-- PROVED TO GO RED, each probe inside BEGIN ... ROLLBACK against the live snapshot:
--   unreconciled_count = 1      -> PROBLEM, naming the prospect id in the detail line
--   invariant_breach_count = 2  -> PROBLEM
--   unreachable_count = 3       -> PROBLEM
--   incomplete = true           -> PROBLEM
--   computed_at 2 hours old     -> PROBLEM, "120 minutes old, past the 90-minute limit"
--   uploaded_count = 0          -> UNKNOWN, "Nothing to evaluate... This is not a pass."
--   snapshot row deleted        -> UNKNOWN, "No suppression reconciliation has run yet."
-- Live state re-read after every probe: still OK, one row present. A monitor that has never
-- been seen to go red is a monitor nobody has tested.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY THIS EXISTS, AND WHY IT IS THE HALF THAT MATTERS
--
-- On 2026-09-04 a prospect uploaded 2026-08-21 and suppressed in our database was Active at
-- the sending provider, had been sent email 3 on 2026-08-31, and had email 4 queued behind a
-- seven-day delay. Every instrument in this platform read green throughout.
--
-- The missing API call was the smaller half. The larger half is that NOTHING WOULD HAVE SAID
-- SO, and no amount of care on the write paths fixes that, because two of the four
-- suppression write sites are code and THE ONE THAT ACTUALLY BIT WAS A HAND-WRITTEN UPDATE.
-- A person typing UPDATE prospects SET suppressed = true is not something a code path can
-- catch.
--
-- Nor can prospects.outbound_suppression_status, added in the migration before this one. A
-- hand UPDATE leaves it NULL, and using our own columns to audit our own writes is the exact
-- shape this codebase keeps producing: a check that runs, reports success, and cannot see
-- the class it was written to find. The monitor sweep whose loop never reached mon_019 and
-- the anon-privilege audit that could not see views are the same mistake.
--
-- So the sweep behind this monitor reads THE PROVIDER, per lead, and compares the answer
-- against findBlockedProspects, the send gate. It never consults the suppression columns to
-- decide anything.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY A STORED VERDICT AND NOT A VIEW THAT COMPUTES IT
--
-- Every other mon_NNN view computes its own state from the database. This one cannot: the
-- comparison needs an HTTP call to the provider, and a view cannot make one.
--
-- MON-023 already solved this shape. A cron computes the verdict, stores it in a singleton
-- row, and a thin view checks the verdict is FRESH and GREEN. The freshness half is what
-- stops a stored verdict from being trusted for ever after the writer dies: without it, a
-- sweep that stopped running would leave its last "all clear" on the board indefinitely,
-- which is the same silence this whole monitor exists to break.
--
-- THE FRESHNESS CHECK RUNS FIRST, before any count is read. A stale all-clear is not an
-- all-clear, and neither is a stale alarm.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT MAKES IT RED, AND WHY 'UNREACHABLE' IS NOT A PASS
--
--   unreconciled_count > 0      a suppressed prospect the provider is still sending to
--   invariant_breach_count > 0  a prospect marked uploaded with no provider lead id, so the
--                               sweep is structurally unable to check them
--   unreachable_count > 0       a suppressed lead the provider would not tell us about
--   incomplete                  the sweep could not finish, so its counts are a floor
--
-- unreachable is red on purpose. "We could not tell" and "it is fine" are different answers,
-- and rendering the first as the second is how a check becomes decoration. It is the same
-- reason the send gate fails closed rather than treating an unreadable suppression list as
-- an empty one.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- VACUOUS TRUTH
--
-- Every rule above is "no row is in a bad state", and all of those are trivially true over
-- an empty set. This codebase has shipped that mistake often enough for CLAUDE.md to name it.
--
-- The denominator here is uploaded_count: prospects the provider could possibly hold. When
-- that is zero the sweep had nothing to look at at all and the state is UNKNOWN, not OK.
--
-- When uploaded_count is non-zero but blocked_count is zero, the state IS OK, and the
-- distinction is worth stating rather than collapsing. The upload invariant genuinely ran
-- over every uploaded row, so a real check passed over a real set; only the "still sending"
-- comparison had nothing to compare. The detail line says so in those words rather than
-- reporting a bare zero, because a bare zero is what a sweep that examined nothing also
-- reports.

CREATE TABLE IF NOT EXISTS public.suppression_reconciliation_snapshot (
  id                        integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),

  -- The denominator. Prospects the provider could still hold at all.
  uploaded_count            integer NOT NULL,
  -- Of those, how many the send gate says must not be mailed.
  blocked_count             integer NOT NULL,
  -- Of those, how many were actually read back from the provider this run.
  checked_count             integer NOT NULL,

  -- THE NUMBER THIS WHOLE THING IS FOR. Expected zero.
  unreconciled_count        integer NOT NULL,
  -- Suppressed leads the provider would not answer for. Unknown, not fine.
  unreachable_count         integer NOT NULL,
  -- Suppressed within the settle window and deliberately not judged yet. The provider
  -- applies a stop asynchronously: measured at about 43 seconds on 2026-09-04.
  settling_count            integer NOT NULL,
  -- Uploaded prospects with no provider lead id. The invariant, asserted not assumed.
  invariant_breach_count    integer NOT NULL,

  -- True when the sweep could not finish, so no count above it is a total.
  incomplete                boolean NOT NULL DEFAULT false,

  -- Capped list, so an operator can go straight to the rows rather than writing a query.
  unreconciled_prospect_ids jsonb   NOT NULL DEFAULT '[]'::jsonb,

  -- The sentence an operator reads. Always carries the denominator, because a bare zero is
  -- indistinguishable from a sweep that examined nothing.
  detail                    text    NOT NULL,

  computed_at               timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.suppression_reconciliation_snapshot IS
  'Single-row verdict from /api/cron/suppression-reconcile, which reads the sending '
  'provider live for every prospect the send gate says must not be mailed. Read by mon_026.';

-- Service-role only, BOTH LAYERS. RLS is what protects the rows today; the by-name REVOKE is
-- the second layer, because Supabase grants every new public table to anon and authenticated
-- BY NAME and "RLS on, no policies" leaves that grant sitting underneath it. See the
-- 2026-08-25 verification_calls incident in CLAUDE.md.
ALTER TABLE public.suppression_reconciliation_snapshot ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.suppression_reconciliation_snapshot FROM PUBLIC;
REVOKE ALL ON TABLE public.suppression_reconciliation_snapshot FROM anon, authenticated;
GRANT ALL ON TABLE public.suppression_reconciliation_snapshot TO service_role;

-- ── THE MONITOR ───────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.mon_026 AS
WITH snap AS (
  SELECT * FROM public.suppression_reconciliation_snapshot WHERE id = 1
)
SELECT
  'MON-026'::text AS check_code,
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM snap)                                    THEN 'UNKNOWN'::text
    -- FRESHNESS FIRST. The sweep runs every 30 minutes; 90 allows two missed runs before
    -- alarming, and a stale verdict is never trusted whatever it says.
    WHEN (SELECT computed_at FROM snap) < now() - interval '90 minutes'     THEN 'PROBLEM'::text
    -- Vacuous truth is not a pass. See the header.
    WHEN (SELECT uploaded_count FROM snap) = 0                              THEN 'UNKNOWN'::text
    WHEN (SELECT unreconciled_count FROM snap) > 0                          THEN 'PROBLEM'::text
    WHEN (SELECT invariant_breach_count FROM snap) > 0                      THEN 'PROBLEM'::text
    WHEN (SELECT unreachable_count FROM snap) > 0                           THEN 'PROBLEM'::text
    WHEN (SELECT incomplete FROM snap)                                      THEN 'PROBLEM'::text
    ELSE 'OK'::text
  END AS state,
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM snap)
      THEN 'No suppression reconciliation has run yet. Expected until the first '
        || 'suppression-reconcile firing after deploy; if it persists, the sweep is not '
        || 'running and nothing is comparing our suppression list against the provider.'
    WHEN (SELECT computed_at FROM snap) < now() - interval '90 minutes'
      THEN 'The suppression reconciliation is '
        || round(EXTRACT(epoch FROM now() - (SELECT computed_at FROM snap)) / 60)::text
        || ' minutes old, past the 90-minute limit. It last said: "'
        || (SELECT detail FROM snap)
        || '" That answer describes a window that has moved on, so it is not being reported '
        || 'as current. suppression-reconcile runs every 30 minutes: check it is still running.'
    WHEN (SELECT uploaded_count FROM snap) = 0
      THEN 'Nothing to evaluate: no prospect has been uploaded to the sending provider, so '
        || 'there is nothing the provider could still be sending to. This is not a pass.'
    ELSE (SELECT detail FROM snap)
  END AS detail,
  (SELECT computed_at FROM snap) AS last_run;

REVOKE ALL ON public.mon_026 FROM PUBLIC;
REVOKE ALL ON public.mon_026 FROM anon, authenticated;
GRANT SELECT ON public.mon_026 TO service_role;

-- ── REGISTER THE CHECK ────────────────────────────────────────────────────────
--
-- monitor_checks is what the operator dashboard reads for the title and the plain-English
-- meaning. A view with no row here renders as a bare code. Registered in the SAME migration
-- that creates the view, and the code is added to MONITORS in the same commit. MON-008 and
-- MON-009 are registered with no view and that is the shape this must not repeat.

INSERT INTO public.monitor_checks
  (code, title, description, category, tier, is_scheduled, expected_interval_minutes,
   plain_meaning, plain_impact, plain_action)
VALUES (
  'MON-026',
  'Nobody we have suppressed is still being emailed',
  'Reads the sending provider live for every prospect the send gate says must not be mailed, '
    || 'and reports anyone the provider is still sending to. Also asserts that every prospect '
    || 'marked uploaded carries a provider lead id, without which the sweep cannot check them. '
    || 'Fails on a suppressed prospect still sending, on a missing lead id, on a lead the '
    || 'provider would not answer for, and on a verdict that has stopped being refreshed. '
    || 'Returns UNKNOWN, not OK, when nothing has been uploaded at all.',
  'data_integrity',
  1,
  false,
  NULL,

  'When we decide somebody should not be emailed, the tool that actually sends the email has '
    || 'been told, and has stopped. This check asks the sending tool directly rather than '
    || 'trusting our own records, because our records were the thing that was wrong.',

  'Marking somebody suppressed used to change nothing about the emails already queued for '
    || 'them. On 2026-09-04 a prospect our system had suppressed was still active with the '
    || 'sending tool, had been sent a third email nine days after we stopped them, and had a '
    || 'fourth waiting. Nothing anywhere said so. Continuing to email somebody who asked to be '
    || 'left alone, or who a client rejected, is a complaint, a damaged sending reputation and '
    || 'a broken promise, in that order.',

  'Read the detail line: it names the prospects the sending tool is still sending to. Each '
    || 'one needs stopping at the provider now. Then find out how they were suppressed, '
    || 'because a prospect reaching this state means the suppression did not go through the '
    || 'shared path: a hand-written database UPDATE is the known cause and is what this check '
    || 'was built for. If the line instead says leads could not be read, that is the provider '
    || 'being unreachable rather than anyone being emailed, and it clears on its own once the '
    || 'provider answers again. Never make this go green by editing the snapshot table: the '
    || 'next sweep overwrites it in half an hour with the provider''s own answer.'
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

-- ── SCHEDULE THE SWEEP ────────────────────────────────────────────────────────
--
-- ═════════════════════════════════════════════════════════════════════════════
-- THE SECRET IS NOT IN THIS FILE, AND MUST NOT BE PUT IN IT
--
-- This repository is currently PUBLIC (see CLAUDE.md). The Authorization header has to carry
-- CRON_SECRET literally, because ALTER DATABASE ... SET "app.*" needs superuser on Supabase
-- and current_setting('app.cron_secret', true) therefore returns NULL.
--
-- So this migration does NOT write the header. It COPIES the already-authorised command from
-- the queue-worker job and rewrites only the URL path, which is the pattern every cron
-- migration in this repository uses. The secret is never read, never printed, and never
-- committed. If queue-worker is ever unscheduled, re-point this at another live job.
-- ═════════════════════════════════════════════════════════════════════════════

SELECT cron.unschedule('suppression-reconcile')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'suppression-reconcile');

SELECT cron.schedule(
  'suppression-reconcile',
  '*/30 * * * *',
  replace(
    (SELECT command FROM cron.job WHERE jobname = 'queue-worker'),
    '/api/cron/queue-worker',
    '/api/cron/suppression-reconcile'
  )
);

-- MON-025 compares cron.job against this registry and goes red on a live job nobody
-- declared. Scheduling a job without seeding it here would turn a new monitor into a red
-- board on its first firing, which teaches an operator to ignore both.
--
-- cron-schedule-registry.test.ts holds this seed to the migration files in CI, in the other
-- direction, so it cannot be edited into agreement with a drifted database.
INSERT INTO public.cron_schedule_registry (jobname, schedule, declared_by, notes) VALUES
  ('suppression-reconcile', '*/30 * * * *', '20260904110000_mon_026_suppression_reconciliation.sql',
   'Reads the sending provider live for every suppressed prospect. An instrument, not a remedy: the write paths act, this says when they did not.')
ON CONFLICT (jobname) DO UPDATE SET
  schedule    = EXCLUDED.schedule,
  declared_by = EXCLUDED.declared_by,
  notes       = EXCLUDED.notes,
  updated_at  = now();

-- Read back after applying:
--   SELECT * FROM public.mon_026;
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'suppression-reconcile';
--   SELECT * FROM public.mon_025;   -- must still be OK, with the new job declared
--   SELECT has_table_privilege('anon', 'public.suppression_reconciliation_snapshot', 'SELECT'); -- f
--   SELECT has_table_privilege('anon', 'public.mon_026', 'SELECT');                             -- f
