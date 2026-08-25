-- Migration: store the Apollo enrichment subset we already pay for
-- Date: 2026-08-24
--
-- Status: APPLIED (verified live 2026-08-24)
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY
--
-- bulk_match returns 33 top-level fields and 39 organization fields. The handler parsed
-- 13 of those 72 and discarded the rest, including employment_history, which produces 38
-- of research's 40 winning Apollo candidates. Research then bought the SAME person again
-- via people/match to get it: about 113 duplicate paid calls per 244 researched prospects.
--
-- This column keeps what we have already paid for so nothing has to be bought twice.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY A NAMED SUBSET AND NOT THE WHOLE PAYLOAD
--
-- The payload carries street_address, raw_address, postal_code, city, state,
-- formatted_address, phone, photo_url, personal facebook/twitter/github URLs, and an
-- emails array inside every employment_history entry. Home addresses and personal phone
-- numbers for people who have never heard of us.
--
-- We email the UK and Ireland. UK GDPR data minimisation requires keeping what the
-- purpose needs, not everything the vendor returns, and a home address is not defensible
-- for sending a cold email.
--
-- The shape is decided by an ALLOW-LIST in src/lib/sourcing/apollo-enrichment-subset.ts,
-- so a field Apollo adds later is dropped by default rather than silently stored.
-- assertNoForbiddenFields backs it up by throwing if a prohibited name appears at any
-- nesting depth.
--
-- NOTE, tracked separately in BACKLOG: prospect_research_results.raw_apollo ALREADY
-- stores the full people/match payload, and 113 existing rows carry street_address,
-- formatted_address and nested employment_history emails. That is a pre-existing
-- exposure, not one this migration creates, and it needs its own remediation.

ALTER TABLE prospects
  ADD COLUMN IF NOT EXISTS apollo_enrichment_data jsonb;

COMMENT ON COLUMN prospects.apollo_enrichment_data IS
  'Named subset of the Apollo bulk_match response, already paid for at enrichment. '
  'Shape is an ALLOW-LIST in src/lib/sourcing/apollo-enrichment-subset.ts. Never store '
  'street_address, raw_address, postal_code, city, state, formatted_address, phone, '
  'photo_url, personal social URLs, or any nested emails array: UK GDPR data '
  'minimisation, and we have no purpose for them.';

-- Read by the research agent to avoid re-buying a person enrichment already matched.
-- Partial: only rows that actually carry data are worth indexing, and they are the
-- minority until the ramp.
CREATE INDEX IF NOT EXISTS prospects_apollo_enrichment_data_present_idx
  ON prospects (id)
  WHERE apollo_enrichment_data IS NOT NULL;

-- ═════════════════════════════════════════════════════════════════════════════
-- COUNTRY
--
-- prospects.country ALREADY EXISTS and is already listed in ENRICHMENT_OWNED_FIELDS, so
-- the write path has always been permitted to populate it. ApolloMatch never parsed the
-- field, so it never did. Dead ownership: the right to write a column we did not collect.
--
-- The cost of that was not theoretical. country is NULL on every prospect row, and that
-- is why two German companies were emailed against a standing exclusion rule in the C0
-- send. "Country capture and jurisdiction gate" has been queued as a pre-C1 BUILD; the
-- capture half is not a build, it is parsing a field we already pay for.
--
-- No schema change is needed here. The fix is in the handler, which now parses
-- match.country and writes it as a first-class column rather than burying it in the jsonb,
-- so a jurisdiction gate can query it directly.
--
-- THE GATE ITSELF IS DELIBERATELY NOT IN THIS CHANGE. It must fail closed on NULL, and
-- with every existing row NULL that would block all sending the moment it shipped. It
-- needs its own change, after a backfill, with that decision made explicitly.

-- Verification. Expected: apollo_enrichment_data jsonb nullable, country text nullable.
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'prospects'
   AND column_name IN ('apollo_enrichment_data', 'country')
 ORDER BY column_name;
