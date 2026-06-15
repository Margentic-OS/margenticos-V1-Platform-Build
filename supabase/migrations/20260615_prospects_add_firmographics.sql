-- Phase B: Add firmographic columns to prospects table
-- Enrichment handler will populate these from Apollo bulk_match response.
-- Tiering classification reads these fields to determine Tier 1/2/3 eligibility.
-- All columns nullable; null values indicate Apollo did not return the field.

BEGIN;

-- Add three firmographic columns (nullable, no defaults, no constraints)
ALTER TABLE prospects
  ADD COLUMN company_headcount integer NULL,
  ADD COLUMN company_industry text NULL,
  ADD COLUMN job_title text NULL;

-- Index for tiering workflow: find enriched prospects ready for tiering
CREATE INDEX idx_prospects_enrichment_and_tier_ready
  ON prospects(organisation_id, enrichment_status, sourced_tier)
  WHERE enrichment_status = 'enriched' AND sourced_tier IS NULL;

COMMIT;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
-- ALTER TABLE prospects
--   DROP COLUMN IF EXISTS company_headcount,
--   DROP COLUMN IF EXISTS company_industry,
--   DROP COLUMN IF EXISTS job_title;
-- DROP INDEX IF EXISTS idx_prospects_enrichment_and_tier_ready;
