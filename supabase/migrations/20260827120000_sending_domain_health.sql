-- Per-domain sending health: the two tables and the monitor that reads them.
--
-- Status: APPLIED (verified live 2026-08-27)
--
-- Read-back after apply, all 27 privilege checks, in BOTH directions:
--   sending_mailbox_daily_stats  anon/authenticated SELECT,INSERT,UPDATE,DELETE -> false
--                                service_role       SELECT,INSERT,UPDATE,DELETE -> true
--   sending_health_snapshot      same
--   mon_023                      anon/authenticated SELECT -> false, service_role -> true
--   RLS enabled on both tables, zero policies on both.
--   Whole-database anon audit (readable table with no RLS) -> zero rows.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY THIS EXISTS
--
-- The ramp stop condition is "bounce rate above 2% on any single sending domain". There
-- are five sending domains and ten mailboxes, and until now nothing in the product could
-- see a bounce broken down by domain. campaigns.bounced_count is one number for a campaign
-- that rotates through all five domains at once, so a domain going bad is invisible inside
-- it: 3 bounces in 1,000 pooled sends is 0.3% and looks fine, while the same 3 bounces on
-- one domain that sent 50 is 6% and is a reputation problem.
--
-- Source: GET /api/v2/accounts/analytics/daily, which returns `bounced` alongside `sent`
-- per email account per day. Verified live 2026-08-27. See
-- docs/DISCOVERY-per-domain-health.md for the endpoint survey behind that choice.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY THE THRESHOLDS ARE NOT IN THIS FILE
--
-- Every other MON-NNN view computes its own state in SQL. This one does not, and the
-- reason is that a threshold in SQL cannot be tested here.
--
-- The only database this project has is production. vitest.config.ts refuses to hold
-- Supabase credentials for exactly that reason, so every test that needs a database is
-- blocked, INCLUDING mon_006_per_row.test.ts, the one existing test of a monitor view's
-- threshold logic, which has never executed a single assertion. A threshold nothing can
-- run a test against is a threshold nobody has checked.
--
-- So the arithmetic lives in src/lib/sending-health/, where vitest reaches it without a
-- database, the instantly-poll cron writes the verdict to sending_health_snapshot, and
-- this view reads that verdict. MON-016 already reads a stored verdict the same way
-- (cron_heartbeats.ok), so the sweep needs no special case and MON-023 stays an ordinary
-- code-to-view pair in the registry.
--
-- Decided with Doug 2026-08-27, after the conflict was surfaced rather than worked around.
--
-- ── WHAT A STORED VERDICT COSTS, AND HOW IT IS PAID FOR ──
--
-- A live view cannot go stale. A stored one can: if the cron stops, the last verdict sits
-- there saying "healthy" forever and the monitor reads green because its input stopped
-- arriving. That is the same defect as a check that passes because it had nothing to
-- judge, so the freshness comparison below is not optional decoration. It is the price of
-- the stored verdict and it runs BEFORE the verdict is read.
--
-- The 60-minute limit and the four state names below are duplicated from
-- src/lib/sending-health/thresholds.ts, which is a producer/consumer pair and therefore
-- exactly the shape CLAUDE.md warns drifts. It is guarded rather than trusted:
-- sending-health-sql-parity.test.ts reads THIS FILE and fails if the interval or any
-- state name here stops matching the TypeScript.

-- ═════════════════════════════════════════════════════════════════════════════
-- RAW DATA — one row per mailbox per day
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Grain is mailbox-day, not domain-day, deliberately. Storing the domain rollup only
-- would make it impossible to answer "is it the whole domain or one bad mailbox", which
-- is the first question after the alert fires. sending_domain is derived and stored rather
-- than computed on read so the rollup cannot disagree with itself between queries.

CREATE TABLE IF NOT EXISTS public.sending_mailbox_daily_stats (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  stat_date       date NOT NULL,
  -- The full mailbox address, as the sending tool reports it, lowercased by the writer.
  mailbox         text NOT NULL,
  -- Derived from mailbox by deriveSendingDomain(). Stored, not computed, and lowercased,
  -- because 'Doug@X.com' and 'doug@x.com' splitting into two domain rows would halve each
  -- half's apparent bounce rate. That error hides breaches rather than inventing them.
  sending_domain  text NOT NULL,

  sends           integer NOT NULL DEFAULT 0 CHECK (sends   >= 0),
  bounces         integer NOT NULL DEFAULT 0 CHECK (bounces >= 0),

  fetched_at      timestamptz NOT NULL DEFAULT now(),

  -- THE IDEMPOTENCY GUARANTEE. Every cron run re-fetches the last three days and upserts
  -- on this constraint, so running the fetch twice cannot double a figure. Three days
  -- rather than one because a bounce can be attributed to the day the SEND happened
  -- rather than the day the bounce arrived, so a day's numbers are not final when the day
  -- ends. Re-fetching corrects the day it belongs to instead of losing it.
  CONSTRAINT sending_mailbox_daily_stats_date_mailbox_key UNIQUE (stat_date, mailbox)
);

CREATE INDEX IF NOT EXISTS sending_mailbox_daily_stats_domain_date_idx
  ON public.sending_mailbox_daily_stats (sending_domain, stat_date DESC);

COMMENT ON TABLE public.sending_mailbox_daily_stats IS
  'Daily sends and bounces per sending mailbox. OUR infrastructure, not client data. '
  'Written by the instantly-poll cron via the can_report_sending_health capability.';

-- ═════════════════════════════════════════════════════════════════════════════
-- THE VERDICT — one row, rewritten every run
-- ═════════════════════════════════════════════════════════════════════════════
--
-- SINGLETON, enforced by the CHECK on id. One row means the per-domain breakdown and the
-- overall state are written in a single statement and can never disagree with each other:
-- the dashboard cannot show four healthy domains beside a "failing" headline because a
-- second write landed between two reads.
--
-- domains is jsonb rather than a child table for the same reason. A child table would
-- need a delete-then-insert per run, and a reader arriving mid-run would see a partial
-- breakdown.

CREATE TABLE IF NOT EXISTS public.sending_health_snapshot (
  id              integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),

  -- The four values evaluateSendingHealth() can return. 'stale' is deliberately NOT here:
  -- staleness is a property of how old this row is, not something that can be written
  -- into it. A writer that could stamp 'stale' would be writing a fact about the future.
  overall_state   text NOT NULL CHECK (overall_state IN ('no_data', 'insufficient_sends', 'healthy', 'failing')),

  -- The sentence an operator reads. Carries numerator and denominator, never a bare
  -- percentage, and always states how many domains the rate rule declined to judge.
  detail          text NOT NULL,

  window_start    date NOT NULL,
  window_end      date NOT NULL,

  -- Per-domain breakdown: [{domain, sends, bounces, bounceRate, rateState,
  -- absoluteBreach, domainState}]. What the operator dashboard section renders.
  domains         jsonb NOT NULL DEFAULT '[]'::jsonb,

  computed_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.sending_health_snapshot IS
  'Single-row per-domain sending health verdict, recomputed by instantly-poll every 15 '
  'minutes. Read by mon_023 and by the operator dashboard.';

-- ═════════════════════════════════════════════════════════════════════════════
-- MON-023 — the monitor
-- ═════════════════════════════════════════════════════════════════════════════
--
-- FOUR STATES collapsed onto the sweep's three, and the mapping is the part worth reading:
--
--   failing            -> PROBLEM   a domain is over threshold
--   stale              -> PROBLEM   the fetch stopped; alert, do not wait quietly
--   no_data            -> UNKNOWN   nothing computed, or computed and found nothing
--   insufficient_sends -> OK        the absolute rule ran and passed
--   healthy            -> OK
--
-- insufficient_sends maps to OK on purpose. See ADR-035; ratified by Doug 2026-08-27
-- against live output. Mapping it to UNKNOWN would be more literal
-- and would make this check DARK: the sweep writes an event only on a state CHANGE and
-- treats "no prior event" as UNKNOWN, so a check sitting at UNKNOWN from birth never
-- writes a row and renders exactly like MON-008 — registered, silent, and impossible to
-- tell apart from a monitor nothing queries. The distinction is not lost: it survives in
-- overall_state, which the operator dashboard renders per domain.
--
-- THE FRESHNESS CHECK RUNS FIRST. A stale verdict is not trusted whatever it says,
-- including a stale 'failing'.

CREATE OR REPLACE VIEW public.mon_023 AS
WITH snap AS (
  SELECT * FROM public.sending_health_snapshot WHERE id = 1
)
SELECT
  'MON-023'::text AS check_code,
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM snap) THEN 'UNKNOWN'
    WHEN (SELECT computed_at FROM snap) < now() - interval '60 minutes' THEN 'PROBLEM'
    WHEN (SELECT overall_state FROM snap) = 'failing' THEN 'PROBLEM'
    WHEN (SELECT overall_state FROM snap) = 'no_data' THEN 'UNKNOWN'
    ELSE 'OK'
  END AS state,
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM snap)
      THEN 'No sending-health verdict has been computed yet. Expected until the first '
        || 'instantly-poll run after deploy; if it persists, the fetch is not running.'
    WHEN (SELECT computed_at FROM snap) < now() - interval '60 minutes'
      THEN 'The sending-health verdict is '
        || round(EXTRACT(epoch FROM now() - (SELECT computed_at FROM snap)) / 60)::text
        || ' minutes old, past the 60-minute limit. It last said "'
        || (SELECT overall_state FROM snap)
        || '". That answer describes a window that has moved on, so it is not being '
        || 'reported as current. instantly-poll writes this every 15 minutes: check it '
        || 'is still running.'
    ELSE (SELECT detail FROM snap)
  END AS detail,
  (SELECT computed_at FROM snap) AS last_run;

-- ═════════════════════════════════════════════════════════════════════════════
-- REGISTER THE CHECK
--
-- monitor_checks is what the operator dashboard reads for titles and plain-English
-- meaning. A view with no row here renders as a bare code.
--
-- Registered in the SAME migration that creates the view, and the code is added to
-- MONITORS in the same commit. MON-008 and MON-009 are registered with no view and that
-- is the shape this must not repeat.

INSERT INTO public.monitor_checks
  (code, title, description, category, tier, is_scheduled, expected_interval_minutes,
   plain_meaning, plain_impact, plain_action)
VALUES
  ('MON-023',
   'Sending domain bounce health',
   'Per sending domain over a rolling 7 days: 3 or more bounces at any rate, or a bounce '
   'rate above 2% once that domain has sent at least 50. Also fires if the figures stop '
   'being refreshed.',
   'blind-spot', 1, false, NULL,

   'One of our own sending domains is bouncing more email than it should, or we have '
   'stopped being able to tell. We send from five domains. If one of them starts bouncing, '
   'the damage is to that domain''s reputation, and a single combined number across all '
   'five hides it until it is bad enough to show up everywhere.',

   'Bounces damage the reputation of the domain they came from. Once that reputation drops, '
   'email from that domain starts landing in spam folders instead of inboxes, for every '
   'client using it, and recovering takes weeks. This is the check the sending ramp is '
   'supposed to stop on.',

   'Open the operator dashboard and look at the per-domain table. If one domain is bad and '
   'the others are fine, the problem is that domain: pause it in the sending tool and check '
   'its DNS records. If every domain is bad, the problem is the prospect list, not the '
   'domains, so check email verification is running. If the check says the figures are '
   'stale, nothing is known to be wrong: the 15-minute instantly-poll job has stopped, so '
   'check that first.')
ON CONFLICT (code) DO NOTHING;

-- ═════════════════════════════════════════════════════════════════════════════
-- ACCESS
--
-- Service-role only, confirmed with Doug 2026-08-27. Same posture as verification_calls,
-- job_queue, synthesis_batches and all twenty existing mon_NNN views. The operator
-- dashboard reads these through /api/operator/... with the service client, after checking
-- role = 'operator' (ADR-027). "Operator-only" is enforced in the route, not by a policy.
--
-- RLS IS ENABLED **AND** THE GRANTS ARE REVOKED BY NAME. Both, not either.
--
-- RLS with zero policies genuinely denies every row to anon, and that is what protects
-- these rows today. What it does NOT do is remove the GRANT sitting underneath it:
-- Supabase runs ALTER DEFAULT PRIVILEGES on the public schema granting anon,
-- authenticated and service_role at creation time, so REVOKE ... FROM PUBLIC would be a
-- silent no-op here. That is the 2026-08-25 verification_calls finding, where RLS was the
-- only thing standing between anon and the spend ledger.
--
-- The view needs its own revoke. A view executes with its OWNER's privileges unless it is
-- created with security_invoker, so an anon-readable view over an RLS-protected table
-- hands anon the rows and RLS is never consulted. That is the 2026-08-26 finding.

ALTER TABLE public.sending_mailbox_daily_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sending_health_snapshot     ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.sending_mailbox_daily_stats FROM anon, authenticated;
REVOKE ALL ON TABLE public.sending_health_snapshot     FROM anon, authenticated;
REVOKE ALL ON        public.mon_023                    FROM anon, authenticated;

GRANT ALL    ON TABLE public.sending_mailbox_daily_stats TO service_role;
GRANT ALL    ON TABLE public.sending_health_snapshot     TO service_role;
GRANT SELECT ON        public.mon_023                    TO service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- REGISTER THE CAPABILITY
--
-- ADR-001. Nothing above the handler names the sending tool. Swapping tools is a new row
-- here plus a new handler, and no agent, route or component changes.

INSERT INTO public.integrations_registry
  (tool_name, capability, is_active, api_handler_ref, connection_status)
VALUES
  ('instantly', 'can_report_sending_health', true,
   'src/lib/integrations/handlers/instantly/sending-health', 'connected')
ON CONFLICT DO NOTHING;
