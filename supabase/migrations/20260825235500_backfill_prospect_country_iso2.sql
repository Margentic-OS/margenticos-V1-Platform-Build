-- Backfill prospects.country, and close the DE exclusion that has already failed live.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT WAS ACTUALLY WRONG
--
-- The handover for the catch-all second verifier recorded prospects.country as "0 of 28
-- populated", and treated that as a gap that would bite at re-verification. Measured
-- 2026-08-25, it is worse than that in two ways.
--
-- 1. THE RULE COULD NOT HAVE FIRED EVEN IF THE COLUMN WERE POPULATED.
--    adapter-apollo-enrichment.ts wrote Apollo's country string verbatim ("Germany").
--    send-eligibility-rules.ts matched EXCLUDED_COUNTRIES = {'DE'}. The two never met.
--
-- 2. IT HAS ALREADY LET PROSPECTS THROUGH. Three German prospects sit in the live
--    client-zero organisation. Only craid.de was ever excluded, and it was caught by the
--    .de DOMAIN SUFFIX fallback, not by the country field. The other two:
--
--      broeskamp.udo@broeskamp.com   Bröskamp Consulting GmbH, Frankfurt
--      jochen@knot-consulting.com    Knot Consulting GmbH, Waren
--
--    Both read email_send_eligible = true and outbound_upload_status = 'uploaded'.
--    Both were mailed. A .com domain plus a name-formatted country defeats both layers.
--
-- The code fix (canonical ISO-2 at the write path, alias-tolerant matching at the rule) is
-- in the same commit as this migration. This migration repairs the rows that already exist.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY THE SOURCE IS raw_apollo AND NOT A NEW APOLLO CALL
--
-- The Apollo backfill for apollo_enrichment_data was measured and DECLINED at 28 credits
-- for at most 4 saved calls (docs/BACKLOG.md, 2026-08-25). This backfill is NOT that one and
-- must not be conflated with it: prospect_research_results.raw_apollo->'raw'->>'country'
-- already holds the country for 28 of 28 live unsuppressed prospects, bought and paid for.
-- This costs ZERO Apollo credits.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY THE VALUES ARE NORMALISED HERE RATHER THAN COPIED
--
-- Copying raw would have made things WORSE, not merely incomplete. checkSendEligibility
-- short-circuits on a populated, non-excluded country: an explicit country beats the domain
-- fallback. Writing "Germany" into the column would therefore have flipped craid.de from
-- excluded to ELIGIBLE, turning off the single exclusion that was actually working.
--
-- The CASE below is exhaustive over the four distinct values present, and the assertion
-- that follows FAILS THE MIGRATION if any row would be left unmapped. It is a one-off
-- translation of four known literals, not a second copy of the alias table in
-- src/lib/sourcing/country-code.ts, which remains the source of truth for all new writes.

BEGIN;

-- ── 1. Backfill country as canonical ISO-2, from data already on file ────────────────
WITH latest_apollo AS (
  SELECT DISTINCT ON (prospect_id)
         prospect_id,
         raw_apollo->'raw'->>'country' AS apollo_country
  FROM prospect_research_results
  WHERE raw_apollo->'raw'->>'country' IS NOT NULL
  ORDER BY prospect_id, created_at DESC
)
UPDATE prospects p
SET country = CASE la.apollo_country
                WHEN 'United States' THEN 'US'
                WHEN 'Germany'       THEN 'DE'
                WHEN 'Canada'        THEN 'CA'
                WHEN 'Australia'     THEN 'AU'
              END
FROM latest_apollo la
WHERE la.prospect_id = p.id
  AND p.country IS NULL
  AND la.apollo_country IN ('United States', 'Germany', 'Canada', 'Australia');

-- ── 2. FAIL LOUDLY if any prospect had a country we did not map ──────────────────────
-- An unmapped value silently left NULL is precisely the state this migration exists to end.
-- Better to abort and extend the CASE than to report success over a partial backfill.
DO $$
DECLARE
  unmapped_count integer;
  unmapped_list  text;
BEGIN
  WITH latest_apollo AS (
    SELECT DISTINCT ON (prospect_id)
           prospect_id,
           raw_apollo->'raw'->>'country' AS apollo_country
    FROM prospect_research_results
    WHERE raw_apollo->'raw'->>'country' IS NOT NULL
    ORDER BY prospect_id, created_at DESC
  )
  SELECT count(*), string_agg(DISTINCT la.apollo_country, ', ')
    INTO unmapped_count, unmapped_list
  FROM prospects p
  JOIN latest_apollo la ON la.prospect_id = p.id
  WHERE p.country IS NULL
    AND la.apollo_country NOT IN ('United States', 'Germany', 'Canada', 'Australia');

  IF unmapped_count > 0 THEN
    RAISE EXCEPTION
      'Backfill incomplete: % prospect(s) carry unmapped Apollo countries (%). Extend the CASE above and COUNTRY_ALIASES in src/lib/sourcing/country-code.ts, then re-run.',
      unmapped_count, unmapped_list;
  END IF;
END $$;

-- ── 3. Re-apply the country exclusion to the rows it should always have caught ───────
--
-- SCOPED TO THE COUNTRY RULE AND NOTHING ELSE, deliberately. email_send_eligible is
-- materialised from two independent inputs: the country rule and the verifier's verdict
-- (verification-trigger.ts). Recomputing the whole column here would duplicate verification
-- policy in SQL, which is the same class of mistake as the format mismatch above.
--
-- The country rule can only ever REMOVE eligibility, never grant it, so applying just that
-- half is safe in one direction: a row this touches becomes ineligible and stays ineligible
-- until a human decides otherwise. No row is made MORE sendable by this migration.
UPDATE prospects
SET email_send_eligible = false,
    email_send_ineligible_reason = 'country_excluded_de'
WHERE country = 'DE'
  AND (email_send_eligible IS DISTINCT FROM false
       OR email_send_ineligible_reason IS DISTINCT FROM 'country_excluded_de');

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT THIS MIGRATION DOES NOT DO, and must not be read as having done.
--
-- Marking a prospect ineligible in this database does NOT stop an email sequence already
-- running in the sending tool. broeskamp.com and knot-consulting.com are uploaded and, as
-- far as this repo can tell, in an active sequence. Suppressing them at the sending tool is
-- an operator action against a live external system and is deliberately left to a human.
-- See docs/BACKLOG.md.
--
-- Status: APPLIED (verified live 2026-08-25)
--
-- Live read-back immediately after apply, client-zero, suppressed = false:
--
--   country | n  | eligible | flagged country_excluded_de | uploaded
--   --------+----+----------+-----------------------------+---------
--   AU      |  1 |        1 |                           0 |        1
--   CA      |  2 |        2 |                           0 |        1
--   DE      |  3 |        0 |                           3 |        2
--   US      | 22 |       10 |                           0 |       10
--
-- 28 of 28 now carry a country, against 0 of 28 before. All three German prospects are
-- excluded, where previously only craid.de was. Send-eligible went 15 to 13: exactly the
-- two flips predicted by the dry run, and no other row moved in either direction.
