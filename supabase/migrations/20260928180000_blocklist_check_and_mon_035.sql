-- MON-035 — no sending domain in use is on a public domain blocklist, and the check can see.
--
-- Status: NOT YET APPLIED. Apply via the Supabase MCP apply_migration tool, to BOTH projects
--   for the table, the view and the registry row:
--     hjpvnvjryxdjcfdsfhzy  production
--     tidqheqjzvwmrrrebzir  test
--   The pg_cron job at the bottom is PRODUCTION ONLY and must not be applied to the test
--   project: the command targets the production route, so scheduling it there would run the
--   sweep against production twice a day. Same reasoning as the meeting-outcomes migration.
--
--   REPLACE THE PLACEHOLDER with the real CRON_SECRET at apply time. Never commit the value.
--
--   After applying, verify in BOTH directions and mark this file APPLIED:
--     SELECT has_table_privilege('service_role',  'public.blocklist_check_snapshot', 'SELECT'), -- t
--            has_table_privilege('anon',          'public.blocklist_check_snapshot', 'SELECT'), -- f
--            has_table_privilege('authenticated', 'public.blocklist_check_snapshot', 'SELECT'); -- f
--     SELECT * FROM public.mon_035;   -- expect UNKNOWN, "No blocklist check has run yet."
--     SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'blocklist-check';
--   And regenerate src/types/database.ts, which carries hand-written entries for this table
--   and view until then.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY THIS EXISTS
--
-- On 2026-09-28 a manual blocklist query found getmargenticos.com and inboxmargenticos.com
-- on SURBL's abuse list. inboxmargenticos.com was sending the live campaign at the time and
-- every instrument this platform had read it as healthy:
--
--   Gmail seed test that same day    Inbox
--   Outlook seed test that same day  Inbox
--   Instantly warmup                 100% health, landed_inbox = sent every day
--   Bounce and reply rates           nothing distinguishable from noise at ~107 sends
--
-- A seed test cannot see a blocklist, and warmup measures placement inside the sending
-- tool's own cooperating network, so it systematically overstates. The listing was invisible
-- until somebody typed a dig command by hand, and nothing would have found it again.
--
-- Four distinct states appeared across five domains that day and no two instruments agreed:
-- two domains clean everywhere, one Gmail-spam and listed, one Gmail-spam and clean, one
-- inboxing everywhere and listed. No single instrument found more than two of the four
-- faults. This monitor is the arm that sees the blocklist one, daily, without anybody
-- remembering to look.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY A STORED VERDICT AND NOT A VIEW THAT COMPUTES IT
--
-- A view cannot make a DNS query. So the cron computes the verdict and this view checks it
-- is FRESH and GREEN, which is the shape MON-023, MON-026 and MON-029 already use.
--
-- THE FRESHNESS CHECK RUNS FIRST, before any count is read. Without it a sweep that died
-- would leave its last all-clear on the board for ever, which is the same silence this
-- monitor exists to break. A stale all-clear is not an all-clear, and neither is a stale
-- alarm.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY A CONTROL FAILURE IS RED, AND WHY THAT IS THE WHOLE POINT
--
-- These blocklists refuse queries from public resolvers, and they refuse in ways that read
-- as a clean result. Measured 2026-09-28 against each list's own published test point:
--
--   8.8.8.8  asked Spamhaus about a domain Spamhaus certainly lists  ->  EMPTY
--   8.8.8.8  asked URIBL about its own test point                    ->  127.0.0.1, refusal
--   1.1.1.1  asked Spamhaus about its own test point                 ->  127.255.255.254, blocked
--   1.1.1.1  asked SURBL                                            ->  timed out
--
-- Read the first line again. A resolver that is blocked returns NOTHING, which is exactly
-- what a genuinely clean domain returns. So a negative answer from these lists carries no
-- information on its own. It means "not listed" only once the same list, in the same run,
-- through the same resolver, has been seen to return a listing for a domain it is known to
-- list.
--
-- That is why each list's test point is queried every run and why failing it is PROBLEM
-- rather than UNKNOWN: an instrument that cannot see is a fault to fix, not an absence of
-- data. A list whose control failed is not asked about our domains at all, because its
-- answers would be meaningless either way.
--
-- A NEGATIVE control runs too, a domain that must not be listed anywhere. The positive
-- control cannot catch a resolver that answers EVERY query with a wildcard address: that
-- passes the positive control perfectly and then reports all five sending domains as
-- listed. One extra query per list turns a five-domain false alarm into a named failure.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- VACUOUS TRUTH
--
-- "No domain is listed" is trivially true over zero domains. The denominator is
-- domains_checked, and when it is zero the state is UNKNOWN, not OK. The domain list comes
-- from sending_mailbox_daily_stats over 30 days, so zero means either nothing has sent in a
-- month or that sync has stopped, and both deserve a look rather than a green tile.

-- ── THE STORED VERDICT ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.blocklist_check_snapshot (
  id                    integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),

  -- THE DENOMINATORS. Both of them, because "no listings" is meaningless without knowing
  -- how many domains were asked about and how many lists were trustworthy enough to ask.
  domains_checked       integer NOT NULL,
  lists_total           integer NOT NULL,
  lists_trusted         integer NOT NULL,

  -- THE NUMBER THIS WHOLE THING IS FOR. Expected zero.
  listed_count          integer NOT NULL,

  -- A list that failed its own control this run. Its silence proves nothing.
  control_failure_count integer NOT NULL,

  -- Domain queries that came back unrecognised on a list whose controls HAD passed, which
  -- usually means rate limiting part way through. Neither listed nor clean.
  refused_count         integer NOT NULL,

  -- True when the run could not finish, so no count above it is a total.
  incomplete            boolean NOT NULL DEFAULT false,

  -- Named, so an operator goes straight to the domain and the list rather than re-deriving.
  listings              jsonb   NOT NULL DEFAULT '[]'::jsonb,
  control_failures      jsonb   NOT NULL DEFAULT '[]'::jsonb,

  -- The sentence an operator reads. Always carries the denominators.
  detail                text    NOT NULL,

  computed_at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.blocklist_check_snapshot IS
  'Single-row verdict from /api/cron/blocklist-check, which queries public domain '
  'blocklists for every sending domain in use and proves in the same run that each list '
  'answered. Read by mon_035.';

-- Service-role only, BOTH LAYERS. RLS is what protects the rows today; the by-name REVOKE is
-- the second layer, because Supabase grants every new public table to anon and authenticated
-- BY NAME and "RLS on, no policies" leaves that grant sitting underneath it. See the
-- 2026-08-25 verification_calls incident in CLAUDE.md.
ALTER TABLE public.blocklist_check_snapshot ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.blocklist_check_snapshot FROM PUBLIC;
REVOKE ALL ON TABLE public.blocklist_check_snapshot FROM anon, authenticated;
GRANT ALL ON TABLE public.blocklist_check_snapshot TO service_role;

-- ── THE MONITOR ───────────────────────────────────────────────────────────────

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
    -- below it unsafe to read, so this is reported ahead of them rather than under them.
    WHEN (SELECT control_failure_count FROM snap) > 0                        THEN 'PROBLEM'::text
    -- Vacuous truth is not a pass. See the header.
    WHEN (SELECT domains_checked FROM snap) = 0                             THEN 'UNKNOWN'::text
    WHEN (SELECT listed_count FROM snap) > 0                                THEN 'PROBLEM'::text
    WHEN (SELECT refused_count FROM snap) > 0                               THEN 'PROBLEM'::text
    WHEN (SELECT incomplete FROM snap)                                      THEN 'PROBLEM'::text
    ELSE 'OK'::text
  END AS state,
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM snap)
      THEN 'No blocklist check has run yet. Expected until the first blocklist-check firing '
        || 'after deploy; if it persists, the sweep is not running and nothing is asking '
        || 'whether our sending domains are blocklisted.'
    WHEN (SELECT computed_at FROM snap) < now() - interval '48 hours'
      THEN 'The blocklist check is '
        || round(EXTRACT(epoch FROM now() - (SELECT computed_at FROM snap)) / 3600)::text
        || ' hours old, past the 48-hour limit. It last said: "'
        || (SELECT detail FROM snap)
        || '" That answer describes a day that has moved on, so it is not being reported as '
        || 'current. blocklist-check runs daily at 12:29 UTC: check it is still running.'
    WHEN (SELECT domains_checked FROM snap) = 0
      THEN 'Nothing to evaluate: no sending domain has appeared in the per-mailbox daily '
        || 'stats in the last 30 days, so no domain was queried. This is not a pass. Either '
        || 'nothing has sent for a month or the sending-stats sync has stopped.'
    ELSE (SELECT detail FROM snap)
  END AS detail,
  (SELECT computed_at FROM snap) AS last_run;

-- Service role only. RLS is one layer and the GRANT is the other; a view runs as its owner
-- unless created with security_invoker, so the grant is the whole of the protection here.
REVOKE ALL ON public.mon_035 FROM PUBLIC;
REVOKE ALL ON public.mon_035 FROM anon, authenticated;
GRANT SELECT ON public.mon_035 TO service_role;

-- ── REGISTER THE CHECK ────────────────────────────────────────────────────────
--
-- monitor_events.check_code is NOT NULL REFERENCES public.monitor_checks(code), so a view
-- and a MONITORS entry without this row means the sweep's INSERT is rejected on every run
-- and the new monitor records nothing while looking registered. That has cost this project
-- twice, MON-033 and then MON-034 two days later. Registered in the SAME migration as the
-- view, and MON-035 is added to MONITORS in this same commit.
INSERT INTO public.monitor_checks
  (code, title, description, category, tier, is_scheduled, expected_interval_minutes,
   plain_meaning, plain_impact, plain_action)
VALUES (
  'MON-035',
  'No sending domain is blocklisted, and the check can see',
  'Queries Spamhaus DBL, SURBL and URIBL once a day for every sending domain that appears '
    || 'in sending_mailbox_daily_stats over the last 30 days. Each list is asked about its '
    || 'own published test point and about a known-clean domain in the SAME run, and a list '
    || 'that fails either control is not asked about our domains at all. PROBLEM when any '
    || 'domain is listed, when any control fails, when a trusted list then refuses a query, '
    || 'or when the verdict is more than 48 hours old. UNKNOWN rather than OK when no '
    || 'domain was in scope, because "none listed" is trivially true over zero domains.',
  'blind-spot',
  1,
  false,
  NULL,
  'Public blocklists are consulted by receiving mail servers. A sending domain on one is '
    || 'penalised on every send until it comes off. This check asks the lists directly, '
    || 'every day, and also proves the lists actually answered.',
  'On 2026-09-28 getmargenticos.com and inboxmargenticos.com were found on SURBL''s abuse '
    || 'list by a hand-typed query. inboxmargenticos.com was sending the live campaign at '
    || 'the time and every existing instrument called it healthy: it passed a Gmail seed '
    || 'test and an Outlook seed test the same day and warmup read 100% inbox. A seed test '
    || 'cannot see a blocklist and warmup measures the sending tool''s own network. Nothing '
    || 'would have found the listing again.',
  'Read the detail line: it names each listed domain and which list, and names any list '
    || 'whose control failed. FOR A LISTING: decide whether to pull that domain from the '
    || 'live campaign first, because removal is reversible and costs only capacity, then '
    || 'follow the list''s own delisting path. A listing usually reflects spamtrap hits, so '
    || 'delisting without changing what caused it tends not to hold. FOR A CONTROL FAILURE: '
    || 'the check is blind, not clean. Most likely the resolver is being refused. Set '
    || 'BLOCKLIST_DNS_RESOLVERS to a resolver that answers all three test points, or set '
    || 'SPAMHAUS_DQS_KEY for a per-account Spamhaus zone. Do not read a green tile from any '
    || 'run that reported a control failure.'
)
ON CONFLICT (code) DO UPDATE SET
  title         = EXCLUDED.title,
  description   = EXCLUDED.description,
  category      = EXCLUDED.category,
  tier          = EXCLUDED.tier,
  plain_meaning = EXCLUDED.plain_meaning,
  plain_impact  = EXCLUDED.plain_impact,
  plain_action  = EXCLUDED.plain_action;

-- ── THE JOB. PRODUCTION ONLY. ─────────────────────────────────────────────────
--
-- 12:29 UTC daily. The live campaign's window is 09:30 to 15:00 America/Detroit, which is
-- 13:30 to 19:00 UTC, so this runs an hour ahead of the day's first send and monitor-sweep
-- (5-59/15) puts it on the board by 12:35.
--
-- Minute 29 was chosen by reading cron.job live on 2026-09-28: across the 13 jobs scheduled,
-- the staggered series between them occupy every minute of the hour except 29, 39, 49 and 59.
-- The 2026-09-10 stagger exists to stop jobs starting in the same second and this keeps to it.
--
-- MON-025 WILL GO RED BETWEEN THIS MIGRATION AND THE LIVE JOB BEING CREATED, because the
-- registry declares a job cron.job does not yet hold. That is the drift check working, and
-- declare-then-create is the correct order. Create the live job in the same session as
-- applying this.
--
-- Unschedule-then-schedule is the idempotent shape used by every cron migration here.
-- To verify:  SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'blocklist-check';
-- To remove:  SELECT cron.unschedule('blocklist-check');

SELECT cron.unschedule('blocklist-check');

SELECT cron.schedule(
  'blocklist-check',
  '29 12 * * *',
  $$
  SELECT
    net.http_post(
      url     := 'https://margenticos-platform.vercel.app/api/cron/blocklist-check',
      headers := jsonb_build_object(
                   'Content-Type',  'application/json',
                   'Authorization', 'Bearer REDACTED_CRON_SECRET_IN_COMMAND'
                 ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 55000
    );
  $$
);

-- active is the THIRD column on purpose: the CI scan reads it by position.
INSERT INTO public.cron_schedule_registry (jobname, schedule, active, declared_by, notes) VALUES
  ('blocklist-check', '29 12 * * *', true, '20260928180000_blocklist_check_and_mon_035.sql',
     'Daily domain blocklist sweep behind MON-035. Queries Spamhaus DBL, SURBL and URIBL for every sending domain in use, with each list''s own test point and a known-clean domain as controls in the same run. Runs an hour before the sending window opens so a listing is on the board before the day''s first send.')
ON CONFLICT (jobname) DO UPDATE SET
  schedule    = EXCLUDED.schedule,
  active      = EXCLUDED.active,
  declared_by = EXCLUDED.declared_by,
  notes       = EXCLUDED.notes;
