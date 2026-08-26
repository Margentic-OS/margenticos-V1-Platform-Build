-- MON-021: the synthesis batch pipeline is alive, moving, and not failing.
-- MON-022: the structural guarantees the batch path depends on are still in place.
--
-- Status: APPLIED (verified live 2026-08-26)
--
-- Read-back after apply:
--
--   mon_021  ->  UNKNOWN, 'The synthesis batch sweep has never run. Expected until its
--                pg_cron job is scheduled.'  Correct: the cron is deliberately unscheduled.
--   mon_022  ->  OK, 'All three uniqueness indexes present, one research path enabled at
--                most, RLS on both tables, and neither reachable by anon or authenticated.'
--   monitor_checks rows for MON-021 and MON-022: 2
--
--   mon_021 / mon_022  anon SELECT -> false, authenticated -> false, service_role -> true
--
-- MON-022 was then PROVED TO GO RED, each probe inside BEGIN ... ROLLBACK:
--
--   DROP INDEX system_flags_research_path_exclusive
--     -> PROBLEM, '...is GONE. Both research paths can now be enabled at once...'
--   DROP INDEX job_queue_one_live_research_per_prospect
--     -> PROBLEM, '...An operator click during a batch wait can now re-buy...'
--   ALTER TABLE synthesis_batch_entries DISABLE ROW LEVEL SECURITY
--     -> PROBLEM, 'Row level security is OFF on one of the synthesis batch tables.'
--   GRANT SELECT ON synthesis_batches TO anon
--     -> PROBLEM, 'anon or authenticated can SELECT a synthesis batch table...'
--
-- A monitor that has never been seen to go red is a monitor nobody has tested.
--
-- THE THIRD PART was verified by watching it FAIL first. With both views created and
-- neither registered in monitors.ts, monitor-sweep-pairs.test.ts reported:
--
--   'these monitor views exist but the sweep never queries them, so they are dark:
--    mon_021, mon_022'
--
-- That is the MON-019 defect being caught by the test written after it.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY TWO MONITORS AND NOT ONE
--
-- The brief asked for one covering batch age, stuck batches and failure rate, plus a live
-- pg_indexes check. Those are two different jobs with two different remedies, and a
-- monitor is only worth having if going red tells you what to do.
--
--   MON-021 red  ->  the pipeline is stalled or failing. Check the sweep, check Anthropic
--                    status, look at synthesis_batches.
--   MON-022 red  ->  a safety guarantee was REMOVED by a migration. Nothing is failing
--                    yet. Restore the index or the grant before the next flag flip.
--
-- Merging them would produce one alarm whose plain_action had to say "either check
-- Anthropic or read a migration diff", which is how an alarm gets ignored.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- ALL THREE PARTS ARE HERE, AND ALL THREE ARE REQUIRED
--
-- A new monitor is dark unless it has its own view, its own monitor_checks row, AND its
-- name in the sweep's registry. MON-019 had two of the three and monitor_events held zero
-- rows for it while the sweep ran happily and its view returned OK.
--
--   the view            below
--   the registration    the monitor_checks INSERT below
--   the check code      src/app/api/cron/monitor-sweep/monitors.ts, as a PAIR
--
-- monitor-sweep-pairs.test.ts scans these migrations for CREATE VIEW mon_NNN and fails if
-- the sweep does not query it, so forgetting the third part is a failing test rather than
-- a silent dark monitor. That test is why this file cannot ship half-registered.

-- ═════════════════════════════════════════════════════════════════════════════
-- MON-021

CREATE OR REPLACE VIEW public.mon_021 AS
WITH hb AS (
  SELECT
    max(ran_at) AS last_run,
    bool_or(NOT ok) FILTER (WHERE ran_at > now() - interval '60 minutes') AS recent_failure,
    max(CASE WHEN ok = false THEN detail ELSE NULL::text END) AS failure_detail
  FROM public.cron_heartbeats
  WHERE job_name = 'synthesis-batch-sweep'
),
batches AS (
  SELECT
    -- UN-RECEIPTED. A ledger row with no Anthropic batch id means we may have submitted
    -- and lost the receipt. Reconciliation clears these within a sweep or two, so one
    -- sitting for half an hour means reconciliation itself is not working, and that is
    -- the one state in this whole system that can lead to paying twice.
    count(*) FILTER (
      WHERE state = 'attempted' AND requested_at < now() - interval '30 minutes'
    ) AS unreceipted,
    -- OVERDUE. Anthropic expires a batch at 24 hours; the sweep ages one out at 25. A
    -- batch still open past 26 means the sweep is not ageing it out either.
    count(*) FILTER (
      WHERE state IN ('submitted', 'ended') AND requested_at < now() - interval '26 hours'
    ) AS overdue,
    max(EXTRACT(epoch FROM (now() - requested_at)) / 3600::numeric)
      FILTER (WHERE state IN ('attempted', 'submitted', 'ended')) AS oldest_open_hours
  FROM public.synthesis_batches
),
entries AS (
  SELECT
    -- STUCK BEFORE SUBMISSION. Sources are already bought for these. If the sweep stops
    -- submitting, this climbs and the money is already spent.
    count(*) FILTER (
      WHERE state = 'pending_submission' AND created_at < now() - interval '30 minutes'
    ) AS stuck_pending,
    count(*) FILTER (
      WHERE state IN ('succeeded', 'collected') AND updated_at > now() - interval '24 hours'
    ) AS good_24h,
    count(*) FILTER (
      WHERE state IN ('errored', 'expired', 'cancelled', 'failed')
        AND updated_at > now() - interval '24 hours'
    ) AS bad_24h,
    count(*) FILTER (
      WHERE doc_superseded AND updated_at > now() - interval '24 hours'
    ) AS superseded_24h
  FROM public.synthesis_batch_entries
)
SELECT
  'MON-021'::text AS check_code,
  CASE
    -- No heartbeat at all means the sweep has never run. Correct BEFORE the pg_cron job
    -- is scheduled, and UNKNOWN rather than PROBLEM is the honest reading of it.
    WHEN hb.last_run IS NULL THEN 'UNKNOWN'::text
    -- Three missed firings against a 5-minute schedule. One is noise, three is a pattern.
    -- READS ok AS WELL AS STALENESS, unlike mon_002, whose shape derives state from
    -- staleness alone so a job that runs punctually and fails every time reads OK there.
    WHEN (EXTRACT(epoch FROM (now() - hb.last_run)) / 60::numeric) > 15::numeric THEN 'PROBLEM'::text
    WHEN hb.recent_failure THEN 'PROBLEM'::text
    WHEN batches.unreceipted > 0 THEN 'PROBLEM'::text
    WHEN batches.overdue > 0 THEN 'PROBLEM'::text
    WHEN entries.stuck_pending > 0 THEN 'PROBLEM'::text
    -- FAILURE RATE, with a floor of 5 so one failure out of two does not alarm. Anthropic
    -- does not bill errored or expired requests, so this costs nothing directly; what it
    -- signals is that prospects are reaching phase 2 with a fallback synthesis and
    -- therefore no researched opening.
    WHEN (entries.good_24h + entries.bad_24h) >= 5
      AND entries.bad_24h::numeric / (entries.good_24h + entries.bad_24h)::numeric > 0.20
      THEN 'PROBLEM'::text
    ELSE 'OK'::text
  END AS state,
  CASE
    WHEN hb.last_run IS NULL
      THEN 'The synthesis batch sweep has never run. Expected until its pg_cron job is scheduled.'
    WHEN (EXTRACT(epoch FROM (now() - hb.last_run)) / 60::numeric) > 15::numeric
      THEN 'Sweep last ran ' || to_char(hb.last_run, 'YYYY-MM-DD HH24:MI:SS UTC') || ', over 15 minutes ago.'
    WHEN hb.recent_failure THEN COALESCE(hb.failure_detail, 'A sweep run failed in the last hour.')
    WHEN batches.unreceipted > 0
      THEN batches.unreceipted || ' batch(es) submitted with no receipt recorded for over 30 minutes. '
        || 'Reconciliation should have attached them. This is the state that can lead to paying twice.'
    WHEN batches.overdue > 0
      THEN batches.overdue || ' batch(es) still open past 26 hours, so the sweep is not ageing them out. '
        || 'Oldest open batch: ' || round(COALESCE(batches.oldest_open_hours, 0), 1) || 'h.'
    WHEN entries.stuck_pending > 0
      THEN entries.stuck_pending || ' entr(ies) have waited over 30 minutes to be submitted. '
        || 'Their sources are already paid for.'
    WHEN (entries.good_24h + entries.bad_24h) >= 5
      AND entries.bad_24h::numeric / (entries.good_24h + entries.bad_24h)::numeric > 0.20
      THEN entries.bad_24h || ' of ' || (entries.good_24h + entries.bad_24h)
        || ' synthesis entries failed in the last 24h.'
    ELSE 'Sweep last ran ' || to_char(hb.last_run, 'YYYY-MM-DD HH24:MI:SS UTC')
      || '. Open batches oldest ' || round(COALESCE(batches.oldest_open_hours, 0), 1) || 'h. '
      || 'Last 24h: ' || entries.good_24h || ' collected, ' || entries.bad_24h || ' failed, '
      || entries.superseded_24h || ' written against a superseded messaging document.'
  END AS detail,
  hb.last_run AS last_run
FROM hb, batches, entries;

INSERT INTO public.monitor_checks
  (code, title, description, category, tier, is_scheduled, expected_interval_minutes,
   plain_meaning, plain_impact, plain_action)
VALUES (
  'MON-021',
  'Synthesis batch pipeline every 5m',
  'Confirms /api/cron/synthesis-batch-sweep is running and succeeding, that no batch is '
    || 'un-receipted or overdue, that no entry is stuck waiting to be submitted, and that '
    || 'the synthesis failure rate over 24h is under 20%.',
  'liveness',
  1,
  true,
  5,
  'The job that sends prospect research off for cheap overnight processing, and picks the '
    || 'answers back up, is working.',
  'If it stops, prospects sit with their research half done: the expensive part is already '
    || 'paid for and the emails never get written. Nothing looks broken from the outside. '
    || 'The un-receipted case is worse than a stall, because it is the one state where the '
    || 'same batch could end up paid for twice.',
  'Check the synthesis-batch-sweep pg_cron job is scheduled and active, then read '
    || 'synthesis_batches ordered by requested_at to see which batches are open and how old '
    || 'they are. A row in state ''attempted'' with a null anthropic_batch_id is the one to '
    || 'look at first.'
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

-- ═════════════════════════════════════════════════════════════════════════════
-- MON-022
--
-- ── WHY A MONITOR AND NOT JUST A TEST ──
--
-- A vitest test scans supabase/migrations for the CREATE statements. Migrations are
-- append-only HISTORY, so that test proves a migration once created an index. It says
-- nothing about whether the index exists NOW, because a later migration is free to drop
-- it and the CREATE stays in the repository, green for ever.
--
-- That limit was found by mutation-testing the test rather than the code: deleting the
-- statement failed one test, RENAMING it failed none, because the assertion was a
-- substring match and the new name contained the old one.
--
-- So the authoritative check is this one, and it reads the live catalog.
--
-- ── WHAT IT WATCHES, AND WHY EACH ONE MATTERS ──
--
-- system_flags_research_path_exclusive
--   Permits at most one of queue_research and queue_research_sources to be enabled. It is
--   why assertQueueConfig can take a MAX across source-fetching job types rather than a
--   SUM. Both are at maxInFlight 20 against an Apify ceiling of 25 concurrent actor runs,
--   so without this index both paths can be enabled and 40 runs become reachable. Apify
--   does not degrade gracefully: it rejects the runs and the jobs fail.
--
-- job_queue_one_live_research_per_prospect
--   One live research job per prospect ACROSS all three research job types. Without it, a
--   prospect waiting 24 hours in research_collect does not block a new research_sources
--   job, and one operator click mid-wait re-buys Apify, Apollo and Brave for every
--   prospect in flight. That is the 10 August 2026 shape: 141 credits for 29 prospects.
--
-- synthesis_batch_entries_one_live_per_prospect
--   Two live entries for one prospect means two synthesis calls paid for and two research
--   rows written, the second overwriting the first's classification.
--
-- RLS and the anon grant on both tables
--   These rows hold four source payloads bought with real money, a client's whole
--   messaging document, and the ledger of Anthropic spend. RLS is one layer; the by-name
--   revoke is the other. CLAUDE.md's 2026-08-25 incident is precisely a case where RLS
--   held and the grant underneath it did not.
--
-- The flag count is checked as well as the index, because the index is the mechanism and
-- "at most one research path enabled" is the property. A property can be violated by
-- something other than its usual mechanism.

CREATE OR REPLACE VIEW public.mon_022 AS
WITH invariants AS (
  SELECT
    (SELECT count(*) FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'system_flags_research_path_exclusive') AS exclusion_index,
    (SELECT count(*) FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'job_queue_one_live_research_per_prospect') AS family_index,
    (SELECT count(*) FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'synthesis_batch_entries_one_live_per_prospect') AS entry_index,
    (SELECT count(*) FROM public.system_flags
      WHERE enabled AND key IN ('queue_research', 'queue_research_sources')) AS enabled_research_paths,
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('synthesis_batches', 'synthesis_batch_entries')
        AND c.relrowsecurity) AS tables_with_rls,
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('synthesis_batches', 'synthesis_batch_entries')
        AND (has_table_privilege('anon', c.oid, 'SELECT')
          OR has_table_privilege('authenticated', c.oid, 'SELECT'))) AS tables_reachable_by_anon
)
SELECT
  'MON-022'::text AS check_code,
  CASE
    WHEN i.exclusion_index = 0 THEN 'PROBLEM'::text
    WHEN i.family_index = 0 THEN 'PROBLEM'::text
    WHEN i.entry_index = 0 THEN 'PROBLEM'::text
    WHEN i.enabled_research_paths > 1 THEN 'PROBLEM'::text
    WHEN i.tables_with_rls < 2 THEN 'PROBLEM'::text
    WHEN i.tables_reachable_by_anon > 0 THEN 'PROBLEM'::text
    ELSE 'OK'::text
  END AS state,
  CASE
    WHEN i.exclusion_index = 0
      THEN 'system_flags_research_path_exclusive is GONE. Both research paths can now be '
        || 'enabled at once, which allows 40 concurrent Apify actor runs against a ceiling '
        || 'of 25, and the Apify assertion in queue config must become a SUM.'
    WHEN i.family_index = 0
      THEN 'job_queue_one_live_research_per_prospect is GONE. An operator click during a '
        || 'batch wait can now re-buy Apify, Apollo and Brave for prospects already in flight.'
    WHEN i.entry_index = 0
      THEN 'synthesis_batch_entries_one_live_per_prospect is GONE. One prospect can now have '
        || 'two synthesis calls paid for and two research rows written.'
    WHEN i.enabled_research_paths > 1
      THEN 'Both queue_research and queue_research_sources are enabled. Apify concurrency is '
        || 'no longer bounded by its measured ceiling.'
    WHEN i.tables_with_rls < 2
      THEN 'Row level security is OFF on one of the synthesis batch tables.'
    WHEN i.tables_reachable_by_anon > 0
      THEN 'anon or authenticated can SELECT a synthesis batch table. Those rows hold paid-for '
        || 'source payloads, a client''s messaging document, and the Anthropic spend ledger.'
    ELSE 'All three uniqueness indexes present, one research path enabled at most, RLS on '
      || 'both tables, and neither reachable by anon or authenticated.'
  END AS detail,
  now() AS last_run
FROM invariants i;

INSERT INTO public.monitor_checks
  (code, title, description, category, tier, is_scheduled, expected_interval_minutes,
   plain_meaning, plain_impact, plain_action)
VALUES (
  'MON-022',
  'Batch research safety guarantees intact',
  'Reads the live catalog to confirm the three uniqueness indexes the batch research path '
    || 'depends on still exist, that at most one research path is enabled, and that both '
    || 'synthesis tables still have RLS on and are not readable by anon or authenticated.',
  'data_integrity',
  1,
  false,
  NULL,
  'The safety rules that stop us paying twice for the same research are still switched on.',
  'Nothing breaks the moment one of these disappears. That is the danger: the system keeps '
    || 'working and quietly loses a protection, and the bill arrives later. Two of these '
    || 'guard against the exact mistake that cost 141 Apollo credits for 29 prospects on '
    || '10 August 2026.',
  'Read the detail line: it names which guarantee is missing and what it protected. Restore '
    || 'it with a migration before enabling the batch research path. Do not work around it.'
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

-- ═════════════════════════════════════════════════════════════════════════════
-- GRANTS ON THE TWO NEW VIEWS
--
-- DELIBERATELY TIGHTER THAN THE OLDER mon_* VIEWS, which are readable by anon and
-- authenticated. That is a pre-existing exposure and not this migration's to fix, but it
-- must not be inherited here.
--
-- A Postgres view runs with its OWNER's privileges unless security_invoker is set, so an
-- anon-readable view over synthesis_batches would hand anon aggregated access to a table
-- this build deliberately revoked from it two migrations ago. That would quietly undo the
-- work rather than extend it.
--
-- Nothing needs anon or authenticated: the monitor sweep reads these views as
-- service_role, and the operator dashboard reads monitor_checks and monitor_events rather
-- than the views themselves.

REVOKE ALL ON public.mon_021 FROM PUBLIC;
REVOKE ALL ON public.mon_022 FROM PUBLIC;
REVOKE ALL ON public.mon_021 FROM anon, authenticated;
REVOKE ALL ON public.mon_022 FROM anon, authenticated;
GRANT SELECT ON public.mon_021 TO service_role;
GRANT SELECT ON public.mon_022 TO service_role;
