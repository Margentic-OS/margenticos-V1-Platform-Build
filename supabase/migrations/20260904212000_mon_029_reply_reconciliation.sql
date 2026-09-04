-- MON-029: every reply the provider holds has a signal row.
--
-- Status: PENDING (not yet applied)
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY THIS IS THE ONE THAT WOULD HAVE CAUGHT IT
--
-- The reply poller advanced its cursor on page-fetch success rather than row-write success,
-- so a reply whose signal row failed to write was stepped over and lost for good. Four
-- instruments were in a position to notice and none of them could:
--
--   MON-003  watches the process-replies heartbeat. A reply that never became a row does
--            not affect whether that job ran or succeeded. Green.
--   MON-014  counts signals unprocessed for 48h. A lost reply has NO ROW TO COUNT. Green.
--   MON-015  counts permanently_failed action rows. A lost reply produces no action. Green.
--   MON-002  watches the instantly-poll heartbeat, which DOES go red on a failed row write —
--            for exactly one 15-minute cycle, because the view reads only the latest
--            heartbeat. The next clean run clears it while the reply stays lost.
--
-- Every one of those asks "did an error happen". The error flag is transient and the loss is
-- permanent, so the instrument's memory is shorter than the fault's. This check asks a
-- question whose answer does not decay: is anything missing right now.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY NOT campaigns.replied_count, WHICH WAS ALREADY THERE AND FREE
--
-- MEASURED 2026-09-04, before designing against it: the one live campaign reported provider
-- replied_count = 2 while we held 3 reply_received signals, with no reply lost. The
-- analytics counter and a count of received-email objects are different quantities. A
-- monitor built on that comparison would rest at a permanent small gap, and a monitor that
-- is always slightly red is one nobody reads.
--
-- The sweep therefore counts the SAME /emails?email_type=received objects the poller itself
-- reads, through the poller's own request function, and matches their ids against
-- signals.external_event_id. Same objects on both sides. A gap has one meaning.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- THE NON-VACUITY GUARD, WHICH IS HALF THE POINT
--
--   zero replies at the provider  -> UNKNOWN, and the detail says why. With no reply in
--                                    existence the check cannot tell a working poller from
--                                    a dead one, and reporting OK would be a pass it has
--                                    not earned. This is the state this monitor is in on
--                                    the day it ships, deliberately.
--   provider unreachable          -> PROBLEM. A campaign we could not read is a campaign
--                                    whose replies we cannot vouch for. Not a pass.
--   sweep incomplete (page cap)   -> PROBLEM. A partial read makes no coverage claim.
--   stale verdict                 -> PROBLEM, checked FIRST. A stale all-clear is not an
--                                    all-clear. MON-023's shape.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY A STORED VERDICT AND A THIN VIEW
--
-- The comparison needs an HTTP call to the provider and a view cannot make one. MON-023 and
-- MON-026 already solved this: a cron computes, a singleton row stores, a thin view checks
-- the row is fresh and green. The sweep runs inside instantly-poll, every 15 minutes, which
-- is where the campaign list, the API key and the provider client already are.

CREATE TABLE IF NOT EXISTS public.reply_reconciliation_snapshot (
  id                     integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  campaigns_checked      integer NOT NULL DEFAULT 0,
  provider_reply_count   integer NOT NULL DEFAULT 0,
  stored_reply_count     integer NOT NULL DEFAULT 0,
  missing_count          integer NOT NULL DEFAULT 0,
  unreachable_campaigns  integer NOT NULL DEFAULT 0,
  incomplete             boolean NOT NULL DEFAULT false,
  missing_sample         text[]  NOT NULL DEFAULT '{}',
  detail                 text,
  computed_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.reply_reconciliation_snapshot ENABLE ROW LEVEL SECURITY;

-- Service-role only, BOTH LAYERS and by name. RLS protects the rows today; the by-name
-- REVOKE is the second layer, because a later permissive policy would otherwise open this
-- with nothing underneath it.
REVOKE ALL ON TABLE public.reply_reconciliation_snapshot FROM PUBLIC;
REVOKE ALL ON TABLE public.reply_reconciliation_snapshot FROM anon, authenticated;
GRANT ALL ON TABLE public.reply_reconciliation_snapshot TO service_role;

CREATE OR REPLACE VIEW public.mon_029 AS
WITH snap AS (
  SELECT * FROM public.reply_reconciliation_snapshot WHERE id = 1
)
SELECT
  'MON-029'::text AS check_code,
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM snap) THEN 'UNKNOWN'
    -- Freshness FIRST, before any count is read.
    WHEN (SELECT computed_at FROM snap) < now() - interval '90 minutes' THEN 'PROBLEM'
    WHEN (SELECT unreachable_campaigns FROM snap) > 0 THEN 'PROBLEM'
    WHEN (SELECT missing_count FROM snap) > 0 THEN 'PROBLEM'
    WHEN (SELECT incomplete FROM snap) THEN 'PROBLEM'
    -- Non-vacuity: nothing to compare is not a pass.
    WHEN (SELECT provider_reply_count FROM snap) = 0 THEN 'UNKNOWN'
    ELSE 'OK'
  END AS state,
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM snap)
      THEN 'No reply reconciliation has run yet. Expected until the first instantly-poll run '
        || 'after deploy; if it persists, the sweep is not running.'
    WHEN (SELECT computed_at FROM snap) < now() - interval '90 minutes'
      THEN 'The reply reconciliation verdict is '
        || (round(EXTRACT(epoch FROM (now() - (SELECT computed_at FROM snap))) / 60))::text
        || ' minutes old, past the 90-minute limit. It last said: '
        || COALESCE((SELECT detail FROM snap), 'no detail')
        || ' That answer describes a window that has moved on. instantly-poll writes this '
        || 'every 15 minutes: check it is still running.'
    ELSE COALESCE((SELECT detail FROM snap), 'no detail')
  END AS detail,
  (SELECT computed_at FROM snap) AS last_run;

REVOKE ALL ON public.mon_029 FROM PUBLIC;
REVOKE ALL ON public.mon_029 FROM anon, authenticated;
GRANT SELECT ON public.mon_029 TO service_role;

INSERT INTO public.monitor_checks
  (code, title, description, category, tier, is_scheduled, expected_interval_minutes,
   plain_meaning, plain_impact, plain_action)
VALUES (
  'MON-029',
  'Every reply the sending tool holds has reached us',
  'Asks the sending tool for the received emails it holds per registered campaign and '
    || 'matches their ids against stored reply signals. Fails on any reply the provider has '
    || 'that we do not, on a campaign that could not be read, on a sweep that did not '
    || 'finish, and on a verdict that has stopped being refreshed. Returns UNKNOWN, not OK, '
    || 'when the provider holds no replies at all.',
  'data_integrity',
  1,
  false,
  NULL,

  'Every reply a prospect has sent us has actually arrived in the system. This check asks '
    || 'the sending tool what it has, rather than trusting our own record of what we '
    || 'collected, because our own record was the thing that was wrong.',

  'The poller used to move its place in the reply list forward whenever it had FETCHED a '
    || 'page, not when it had SAVED the replies on it. A reply that failed to save was '
    || 'skipped and gone. Every other check stayed green: three of them watch for rows that '
    || 'a lost reply never creates, and the fourth went red for fifteen minutes and cleared '
    || 'itself. A missed reply is a prospect who answered and got silence, after we already '
    || 'paid to find, research and write to them.',

  'The detail line names the provider ids of the replies we are missing. Those replies are '
    || 'still in the sending tool inbox: read them there and handle them by hand, because '
    || 'nothing will re-collect them automatically once the cursor is past. Then check '
    || 'MON-027, which reports whether the poller is currently stuck, and the poller logs '
    || 'for why the rows would not save. If the line instead says a campaign could not be '
    || 'read, that is the provider being unreachable rather than replies being lost, and it '
    || 'clears once the provider answers again.'
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
