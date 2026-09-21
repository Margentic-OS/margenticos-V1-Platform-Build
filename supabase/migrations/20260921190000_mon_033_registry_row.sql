-- Status: APPLIED (verified live 2026-09-21, production hjpvnvjryxdjcfdsfhzy and test
-- tidqheqjzvwmrrrebzir). Read back on both: monitor_checks now holds MON-033, and the
-- exact insert the sweep was failing on ('MON-033','OK',...) was replayed inside
-- BEGIN..ROLLBACK on each project and succeeded. Production went 32 registry rows to 33,
-- test 25 to 26.
-- MON-033 was missing its monitor_checks row, so every sweep failed to record it.
--
-- WHAT BROKE. 20260921120000_variant_reassignment_record_and_mon_033.sql created the
-- view, the two prospects columns and the grants, and added MON-033 to the sweep's
-- MONITORS list. It did not seed public.monitor_checks. monitor_events.check_code is
-- NOT NULL REFERENCES public.monitor_checks(code), so the sweep's insert was rejected
-- on every run:
--
--   ERROR: 23503: insert or update on table "monitor_events" violates foreign key
--   constraint "monitor_events_check_code_fkey"
--   DETAIL: Key (check_code)=(MON-033) is not present in table "monitor_checks".
--
-- THE READ HALF WAS FINE, WHICH IS WHY IT SHIPPED. mon_033 returns one row with
-- check_code, state and detail, which is exactly what the sweep selects, so reading the
-- view in isolation proves nothing about this. The sweep also WRITES the check code
-- through a foreign key, and only the pair of view and registry exercises that.
--
-- WHAT IT COST. results.checked++ runs after both reads succeed and the failing insert
-- only increments results.errors, so the sweep read all 30 monitors, failed one write,
-- and set its own heartbeat ok=false. MON-005 watches that heartbeat, so the sweep
-- reported PROBLEM about itself from 2026-09-21 02:20 UTC. Meanwhile MON-033 recorded
-- zero events: the monitor added to catch a document short a variant was itself dark
-- for the whole period, which is the defect-that-hides-defects shape MON-019 already
-- cost this project once.
--
-- mon_033's fourth column is NOT the bug and is deliberately not added here. The sweep
-- names its three columns, and monitor-data/route.ts reads last_run defensively because
-- six views already expose an incident timestamp under another name instead.
INSERT INTO public.monitor_checks
  (code, title, description, category, tier, is_scheduled, expected_interval_minutes,
   plain_meaning, plain_impact, plain_action)
VALUES (
  'MON-033',
  'No prospect moved off a missing variant',
  'Reads prospects.variant_reassigned_at, which resolveVariant writes at the moment it '
    || 'moves a prospect off a variant the live messaging document no longer contains. '
    || 'PROBLEM while a reassignment has happened in the last 24 hours, which means the '
    || 'short document is still live and still moving prospects. Clears itself once the '
    || 'document has its variant back and no further prospect hits the gap.',
  'data_integrity',
  1,
  false,
  NULL,
  'A prospect is emailed the variant they were assigned to. This check watches the times '
    || 'they were quietly moved to a different one because the document lost theirs.',
  'resolveVariant returns the prospect''s stored variant unchanged, and getVariantEmails '
    || 'then cannot find it in the document, so it ships THE FIRST VARIANT''S EMAILS '
    || 'instead. The prospect''s researched opening was written against the offer line of '
    || 'the variant they left, so a researched, personalised opening goes out above a '
    || 'different offer. Measured 2026-09-20: a three-variant document for an '
    || 'organisation with 22 prospects already assigned to the missing variant, 19 of '
    || 'them with research written. The only signal was a logger.warn to stdout, and the '
    || 'logger has no Sentry wiring.',
  'Find the messaging document that lost a variant and restore it, then check the offer '
    || 'lines agree before treating the affected sends as harmless: '
    || 'prospects.variant_reassigned_from records WHICH variant each prospect was moved '
    || 'off, which is what makes a re-research decision possible. GREEN IS NOT PROOF OF '
    || 'NOTHING WRONG: it reports reassignments in the last 24 hours, so a document that '
    || 'lost a variant weeks ago and has already moved everyone it is going to move reads '
    || 'OK here.'
)
ON CONFLICT (code) DO UPDATE SET
  title         = EXCLUDED.title,
  description   = EXCLUDED.description,
  category      = EXCLUDED.category,
  tier          = EXCLUDED.tier,
  plain_meaning = EXCLUDED.plain_meaning,
  plain_impact  = EXCLUDED.plain_impact,
  plain_action  = EXCLUDED.plain_action;
