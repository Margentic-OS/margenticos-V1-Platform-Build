-- MON-035 also watches the corporate domain, and the vacuous-truth guard survives it.
--
-- Status: APPLIED (verified live 2026-09-29) to BOTH projects, for the columns, the view and
--   the monitor_checks text:
--     hjpvnvjryxdjcfdsfhzy  production
--     tidqheqjzvwmrrrebzir  test
--
--   Read back on BOTH, in both directions, all eight privileges per role:
--     sending_domains_checked, brand_domains_checked   present, integer, NULLABLE on both
--     mon_035 reads sending_domains_checked            YES on both
--     listed_count checked ABOVE the vacuous branch    YES on both (position compared in
--                                                      pg_get_viewdef, not assumed)
--     blocklist_check_snapshot   anon ZERO, authenticated ZERO, service_role all 8
--     mon_035                    anon ZERO, authenticated ZERO, service_role holds SELECT
--     test project cron.job      0 rows, as designed
--
--   PRODUCTION, the existing pre-split row, which is the case the COALESCE exists for:
--     domains_checked=5  sending=NULL  brand=NULL  listed=2  computed_at=2026-09-29 12:29Z
--     mon_035 -> PROBLEM, "LISTED: getmargenticos.com on SURBL (127.0.0.64);
--                inboxmargenticos.com on SURBL (127.0.0.64)."
--     So the NULL fell back to domains_checked exactly as intended and the monitor did NOT
--     regress to UNKNOWN over a good verdict. That was the specific risk of a DEFAULT 0.
--
--   TEST PROJECT: mon_035 -> UNKNOWN, "No blocklist check has run yet", which is correct
--     there because no cron runs against it. Born-dark working, not a fault.
--
--   NO NEW CRON JOB. The blocklist-check job already exists from the 2026-09-28 migration
--   and its schedule is unchanged, so there is nothing to add to cron_schedule_registry and
--   MON-025 should not move.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY
--
-- MON-035 shipped on 2026-09-28 checking "every sending domain in use", derived from
-- sending_mailbox_daily_stats over 30 days. That source is a record of what ACTUALLY SENT,
-- which is the right source for sending domains and structurally the wrong one for
-- margenticos.com: the corporate domain has no mailboxes, never sends, and therefore could
-- never appear in that table however long the window. The one domain the business rests on
-- was the one domain the monitor could not see.
--
-- It needs watching because a blocklist operator that decides a set of lookalike domains is
-- running cold outreach can escalate to the registrant's main domain. That is the recorded
-- reason no SURBL delisting request was filed for getmargenticos.com or inboxmargenticos.com
-- on 2026-09-29: a request draws attention to the relationship between the lookalikes and
-- the brand. The decision was to let the listings age out and rest the domains instead. If
-- the escalation happens anyway, this is the arm that sees it, and a listing on
-- margenticos.com is worse than any sending-domain listing: it reaches the website, the
-- reply-to address, and every message the business sends from anywhere.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY TWO COUNTS AND NOT ONE, WHICH IS THE WHOLE POINT OF THIS MIGRATION
--
-- The obvious change was to append margenticos.com to the domain list and stop. That would
-- have silently retired an existing guard.
--
-- mon_035 reads `domains_checked = 0` to mean "nothing was in scope", which it renders as
-- UNKNOWN, and the header of the previous migration explains what that catches: either
-- nothing has sent for a month, or the sending-stats sync has stopped. The brand list is a
-- non-empty HARDCODED FLOOR. So folding it into the same count makes that count permanently
-- non-zero, the branch unreachable, and the sync failure invisible. The feature would work
-- and something would quietly stop watching.
--
-- This is the shape CLAUDE.md names against repeatedly: the parallel arrays where mon_019 was
-- never queried, the `as` cast that switched off the check that would have caught the missing
-- job type, the audit query whose relkind filter could not see a view. In each the addition
-- was correct and the guard was gone.
--
-- So sending and brand domains are counted SEPARATELY, and the vacuous-truth branch keeps
-- reading the SENDING count.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY THE NEW COLUMNS ARE NULLABLE AND NOT `NOT NULL DEFAULT 0`
--
-- There is one existing row, written before this migration, whose domains_checked counts
-- sending domains only. A DEFAULT 0 would give that row sending_domains_checked = 0 and the
-- monitor would read UNKNOWN over a perfectly good verdict until the next firing.
--
-- NULL means "this row predates the split", and the view COALESCEs to domains_checked, which
-- for those rows means exactly what it used to. Every row written after the code deploys sets
-- both explicitly.

ALTER TABLE public.blocklist_check_snapshot
  ADD COLUMN IF NOT EXISTS sending_domains_checked integer,
  ADD COLUMN IF NOT EXISTS brand_domains_checked   integer;

COMMENT ON COLUMN public.blocklist_check_snapshot.sending_domains_checked IS
  'Sending domains queried, from sending_mailbox_daily_stats over 30 days. THE denominator '
  'mon_035 uses for its vacuous-truth check. NULL on rows written before 2026-09-29, where '
  'domains_checked carried this meaning. Kept apart from brand_domains_checked because the '
  'brand list is a non-empty hardcoded floor, so a combined count could never reach zero and '
  'the "sending-stats sync has stopped" guard would be dead code.';

COMMENT ON COLUMN public.blocklist_check_snapshot.brand_domains_checked IS
  'Domains checked regardless of whether they send, currently margenticos.com. Excludes any '
  'that also appeared as a sending domain, so nothing is counted or queried twice.';

-- ── THE MONITOR, REPLACED ─────────────────────────────────────────────────────
--
-- Two changes from the 2026-09-28 version:
--
--   1. The vacuous-truth branch reads COALESCE(sending_domains_checked, domains_checked)
--      instead of domains_checked, per the header.
--
--   2. THE LISTING CHECK NOW RUNS BEFORE THE VACUOUS-TRUTH BRANCH. In the previous ordering,
--      `domains_checked = 0 -> UNKNOWN` sat above `listed_count > 0 -> PROBLEM`, so a run
--      that found a real listing while the sending scope was empty reported UNKNOWN and the
--      listing was masked. That combination is now reachable in a way it was not before:
--      brand domains are queried even when no sending domain is in scope, so a brand-domain
--      listing during a sending-stats outage is exactly the case that would have been hidden.
--      A confirmed listing is never less urgent than an uncertain scope.
CREATE OR REPLACE VIEW public.mon_035 AS
WITH snap AS (
  SELECT * FROM public.blocklist_check_snapshot WHERE id = 1
)
SELECT
  'MON-035'::text AS check_code,
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM snap)                                    THEN 'UNKNOWN'::text
    -- FRESHNESS FIRST, before any count is read. Daily job, so 48 hours allows one missed
    -- run before alarming.
    WHEN (SELECT computed_at FROM snap) < now() - interval '48 hours'        THEN 'PROBLEM'::text
    -- INSTRUMENT BEFORE FINDINGS. A list that could not answer makes every clean result
    -- below it unsafe to read.
    WHEN (SELECT control_failure_count FROM snap) > 0                        THEN 'PROBLEM'::text
    -- A CONFIRMED LISTING OUTRANKS AN UNCERTAIN SCOPE. Above the vacuous-truth branch on
    -- purpose: see change 2 in the header.
    WHEN (SELECT listed_count FROM snap) > 0                                THEN 'PROBLEM'::text
    -- Vacuous truth is not a pass, and the denominator is the SENDING count.
    WHEN COALESCE((SELECT sending_domains_checked FROM snap),
                  (SELECT domains_checked FROM snap)) = 0                   THEN 'UNKNOWN'::text
    WHEN (SELECT refused_count FROM snap) > 0                               THEN 'PROBLEM'::text
    WHEN (SELECT incomplete FROM snap)                                      THEN 'PROBLEM'::text
    ELSE 'OK'::text
  END AS state,
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM snap)
      THEN 'No blocklist check has run yet. Expected until the first blocklist-check firing '
        || 'after deploy; if it persists, the sweep is not running and nothing is asking '
        || 'whether our sending domains or the corporate domain are blocklisted.'
    WHEN (SELECT computed_at FROM snap) < now() - interval '48 hours'
      THEN 'The blocklist check is '
        || round(EXTRACT(epoch FROM now() - (SELECT computed_at FROM snap)) / 3600)::text
        || ' hours old, past the 48-hour limit. It last said: "'
        || (SELECT detail FROM snap)
        || '" That answer describes a day that has moved on, so it is not being reported as '
        || 'current. blocklist-check runs daily at 12:29 UTC: check it is still running.'
    WHEN COALESCE((SELECT sending_domains_checked FROM snap),
                  (SELECT domains_checked FROM snap)) = 0
      THEN 'No SENDING domain has appeared in the per-mailbox daily stats in the last 30 '
        || 'days, so only the corporate domain was queried. This is not a pass. Either '
        || 'nothing has sent for a month or the sending-stats sync has stopped. The brand '
        || 'half of the sweep still ran, and its result was: "'
        || (SELECT detail FROM snap) || '"'
    ELSE (SELECT detail FROM snap)
  END AS detail,
  (SELECT computed_at FROM snap) AS last_run;

-- Service role only. RLS is one layer and the GRANT is the other; a view runs as its owner
-- unless created with security_invoker, so the grant is the whole of the protection here.
-- CREATE OR REPLACE VIEW preserves existing grants, but they are restated so this file is
-- the complete statement of who can reach it rather than a diff against the last one.
REVOKE ALL ON public.mon_035 FROM PUBLIC;
REVOKE ALL ON public.mon_035 FROM anon, authenticated;
GRANT SELECT ON public.mon_035 TO service_role;

-- ── THE REGISTERED DESCRIPTION, UPDATED ───────────────────────────────────────
--
-- The monitor_checks row already exists. Only the operator-facing text changes: the previous
-- wording promised "every sending domain" and would now understate what the check covers.
UPDATE public.monitor_checks SET
  title = 'No sending domain or the corporate domain is blocklisted, and the check can see',
  description =
    'Queries Spamhaus DBL, SURBL and URIBL once a day for every sending domain that appears '
    || 'in sending_mailbox_daily_stats over the last 30 days, PLUS the corporate domain '
    || 'margenticos.com, which has no mailboxes and so can never appear in those stats. Each '
    || 'list is asked about its own published test point and about a known-clean domain in '
    || 'the SAME run, and a list that fails either control is not asked about our domains at '
    || 'all. PROBLEM when any domain is listed, when any control fails, when a trusted list '
    || 'then refuses a query, or when the verdict is more than 48 hours old. UNKNOWN rather '
    || 'than OK when no SENDING domain was in scope, which is counted separately from the '
    || 'brand domain precisely so that the hardcoded brand floor cannot mask a sending-stats '
    || 'outage.',
  plain_impact =
    'On 2026-09-28 getmargenticos.com and inboxmargenticos.com were found on SURBL''s abuse '
    || 'list by a hand-typed query. inboxmargenticos.com was sending the live campaign at the '
    || 'time and every existing instrument called it healthy: it passed a Gmail seed test and '
    || 'an Outlook seed test the same day and warmup read 100% inbox. A seed test cannot see '
    || 'a blocklist and warmup measures the sending tool''s own network. On 2026-09-29 the '
    || 'decision was taken NOT to file a delisting request, because SURBL has been escalating '
    || 'cold-outreach listings to the corporate domain behind lookalike sending domains, and '
    || 'a request would draw attention to that relationship. The listings are being left to '
    || 'age out while the domains rest. margenticos.com was added to this check in the same '
    || 'decision: if the escalation happens anyway, this is what sees it.',
  plain_action =
    'Read the detail line: it names each listed domain and which list, and names any list '
    || 'whose control failed. FOR A LISTING ON margenticos.com: escalate immediately, this is '
    || 'the corporate domain and it carries the website and every reply-to address. FOR A '
    || 'LISTING ON A SENDING DOMAIN: decide whether to pull that domain from the live '
    || 'campaign first, because removal is reversible and costs only capacity. A listing '
    || 'usually reflects spamtrap hits, so delisting without changing what caused it tends '
    || 'not to hold, and filing a request is not always the right move: see plain_impact. FOR '
    || 'A CONTROL FAILURE: the check is blind, not clean. Most likely the resolver is being '
    || 'refused. Set BLOCKLIST_DNS_RESOLVERS to a resolver that answers all three test '
    || 'points, or set SPAMHAUS_DQS_KEY for a per-account Spamhaus zone. Do not read a green '
    || 'tile from any run that reported a control failure.'
WHERE code = 'MON-035';
