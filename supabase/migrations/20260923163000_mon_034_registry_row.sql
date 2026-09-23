-- MON-034 was missing its monitor_checks row, so every sweep would have failed to record it.
--
-- Status: APPLIED (verified live 2026-09-23, production hjpvnvjryxdjcfdsfhzy and test
-- tidqheqjzvwmrrrebzir).
--
-- ═════════════════════════════════════════════════════════════════════════════
-- THIS IS THE MON-033 DEFECT, REPEATED TWO DAYS LATER BY SOMEONE WHO HAD THE
-- WRITE-UP AVAILABLE AND DID NOT READ IT FIRST.
--
-- 20260921190000_mon_033_registry_row.sql documents this exact failure in detail:
-- creating the view, the grants and the MONITORS entry, and not seeding
-- public.monitor_checks. monitor_events.check_code is NOT NULL REFERENCES
-- public.monitor_checks(code), so the sweep's insert is rejected on every run:
--
--   ERROR: 23503: insert or update on table "monitor_events" violates foreign key
--   constraint "monitor_events_check_code_fkey"
--
-- THE READ HALF IS FINE, WHICH IS WHY IT PASSES EVERY CHECK THAT ONLY READS.
-- mon_034 returns check_code, state and detail, exactly what the sweep selects, and it
-- was verified live returning PROBLEM with a correct detail line. Reading the view proves
-- nothing about this, because the sweep also WRITES the check code through a foreign key
-- and only the PAIR of view and registry row exercises that seam. It is the
-- half-tests-cannot-see-a-join shape: both ends correct, the handoff untested.
--
-- WHAT IT WOULD HAVE COST. results.checked++ runs after the reads, and the failing insert
-- only increments results.errors, so the sweep would have read every monitor, failed one
-- write, and set its own heartbeat ok=false. MON-005 watches that heartbeat and would
-- have reported PROBLEM about the sweep. Meanwhile MON-034 would have recorded zero
-- events: the monitor added to catch a research source going dark would itself have been
-- dark. That is the defect-that-hides-defects shape, which MON-019 and then MON-033
-- already cost this project twice.
--
-- CAUGHT BY monitor_sweep_contract.live.test.ts, which replays the sweep's real insert
-- inside BEGIN..ROLLBACK for every registered monitor. That test exists because of
-- MON-033. It worked.
-- ═════════════════════════════════════════════════════════════════════════════
INSERT INTO public.monitor_checks
  (code, title, description, category, tier, is_scheduled, expected_interval_minutes,
   plain_meaning, plain_impact, plain_action)
VALUES (
  'MON-034',
  'No research source has stopped coming back',
  'Reads sources_successful on prospect_research_results over the last 7 days, counting '
    || 'fetching runs only, and reports the rate at which each of the four sources came '
    || 'back. PROBLEM when any source is below 50%. UNKNOWN rather than OK when there has '
    || 'been no fetching run at all, because every rate passes vacuously over zero rows '
    || 'and a check born dark reporting OK is the failure this monitor exists to catch.',
  'data_integrity',
  1,
  false,
  NULL,
  'Research reads four sources per prospect. This check watches whether each one is '
    || 'actually answering, rather than whether the run said it finished.',
  'On 2026-09-21 Apify returned HTTP 402 for 50 of 84 prospects. The run completed, wrote '
    || '84 research rows and reported completed 84, failed 0. Those 50 prospects were then '
    || 'researched from Apollo and web search alone, neither of which holds a dated event, '
    || 'so the copy that shipped was built on employment history and headcount. Only 2 of '
    || 'the 84 shipped a trigger built from a recent event. Nothing in the system said a '
    || 'source had been unavailable, because a source failing was not a prospect failing '
    || 'and nothing counted it.',
  'Find which source is below its floor: the detail line names it first and prints every '
    || 'rate to one decimal. Then check that provider''s account before re-running '
    || 'anything, because a source that is down stays down for every prospect and a '
    || 're-run spends money producing the same degraded copy. GREEN IS NOT PROOF OF '
    || 'NOTHING WRONG: since 2026-09-23 a prospect whose holding source failed is HELD '
    || 'and writes no row, so a total outage appears here as rows going MISSING rather '
    || 'than as a source absent from the rows that exist. This check catches the slow '
    || 'version, a source degrading across days while runs continue.'
)
ON CONFLICT (code) DO UPDATE SET
  title         = EXCLUDED.title,
  description   = EXCLUDED.description,
  category      = EXCLUDED.category,
  tier          = EXCLUDED.tier,
  plain_meaning = EXCLUDED.plain_meaning,
  plain_impact  = EXCLUDED.plain_impact,
  plain_action  = EXCLUDED.plain_action;
