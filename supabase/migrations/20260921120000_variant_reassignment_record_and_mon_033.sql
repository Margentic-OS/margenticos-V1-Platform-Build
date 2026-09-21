-- Status: APPLIED (verified live 2026-09-21, production hjpvnvjryxdjcfdsfhzy and test
-- tidqheqjzvwmrrrebzir). Read back on both: both columns present on prospects, mon_033
-- exists as a view, and anon and authenticated hold NONE of the eight table privileges
-- on it. Checked in both directions, per the standing rule: reading only the role that
-- must have access proves nothing about who else does.
-- A prospect whose assigned variant is not in the live messaging document, recorded and
-- monitored.
--
-- WHAT WENT WRONG WITHOUT THIS. resolveVariant returns prospect.variant_id unchanged if it
-- is set, and getVariantEmails then could not find that variant in the document, logged a
-- warning, and shipped THE FIRST VARIANT'S EMAILS instead. The prospect's researched
-- opening was written for one variant's offer line and shipped above a different one. The
-- warning went to stdout: the logger has no Sentry wiring, no monitor read it, and the
-- approval screen never showed how many variants a document had.
--
-- Measured 2026-09-20: a three-variant document was produced for an organisation with 22
-- prospects already assigned to the missing variant, 19 of them with research written.
--
-- Two columns, not one. WHICH variant it was moved off is the part that makes a
-- re-research decision possible later; a timestamp alone says something happened and
-- leaves you unable to act on it.
ALTER TABLE public.prospects
  ADD COLUMN IF NOT EXISTS variant_reassigned_from text,
  ADD COLUMN IF NOT EXISTS variant_reassigned_at   timestamptz;

COMMENT ON COLUMN public.prospects.variant_reassigned_from IS
  'The variant this prospect was assigned to before the live messaging document stopped '
  'containing it. NULL means the prospect has never been reassigned. Written by '
  'resolveVariant in compose-sequence.ts at composition time.';

COMMENT ON COLUMN public.prospects.variant_reassigned_at IS
  'When the reassignment happened. Read by mon_033.';

-- MON-033. Reassignment is a correction, not a failure, so a single reassignment is NOT a
-- PROBLEM: it is the system doing the right thing with a document that lost a variant.
-- What it reports is that it HAPPENED, because the operator needs to know a document is
-- short a variant and that live prospects moved because of it.
--
-- PROBLEM only when reassignment is still happening AFTER the operator has had a day to
-- notice, which means the short document is now the steady state rather than a transition.
CREATE OR REPLACE VIEW public.mon_033 AS
WITH r AS (
  SELECT
    count(*)                                                     AS total,
    count(*) FILTER (WHERE variant_reassigned_at > now() - interval '24 hours') AS last_day,
    count(DISTINCT organisation_id)                              AS orgs,
    max(variant_reassigned_at)                                   AS latest,
    (array_agg(DISTINCT variant_reassigned_from))[1:4]           AS moved_off
  FROM public.prospects
  WHERE variant_reassigned_at IS NOT NULL
)
SELECT
  'MON-033'::text AS check_code,
  -- PROBLEM while it is still happening, and it clears itself once the document gets its
  -- variant back and no further prospect hits the gap. An earlier draft had a second
  -- branch for "still reassigning a day later"; it was DEAD, because last_day > 0 and
  -- latest older than 24 hours cannot both be true. One condition, and it is readable.
  CASE
    WHEN (SELECT last_day FROM r) > 0 THEN 'PROBLEM'
    ELSE 'OK'
  END AS state,
  CASE
    WHEN (SELECT total FROM r) = 0
      THEN 'No prospect has been reassigned off a missing variant.'
    ELSE (SELECT last_day FROM r)::text
      || ' prospect(s) reassigned in the last 24 hours, '
      || (SELECT total FROM r)::text || ' in total, across '
      || (SELECT orgs FROM r)::text || ' organisation(s). Moved off variant(s): '
      || COALESCE(array_to_string((SELECT moved_off FROM r), ', '), '(unknown)')
      || '. A live messaging document is missing a variant its prospects were assigned to. '
      || 'Their researched openings were written against the offer line of the variant they '
      || 'left, so check those offer lines agree before treating this as harmless.'
  END AS detail;

-- Service role only, per the standing rule: RLS is one layer and the GRANT is the other.
REVOKE ALL ON public.mon_033 FROM PUBLIC;
REVOKE ALL ON public.mon_033 FROM anon, authenticated;
GRANT SELECT ON public.mon_033 TO service_role;
