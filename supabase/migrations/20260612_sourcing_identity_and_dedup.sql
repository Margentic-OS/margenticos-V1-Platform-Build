-- Migration: Sourcing identity and deduplication groundwork
-- Purpose: Add source identity tracking and deduplication indexes for prospect sourcing.
-- Also fixes the qualification_status CHECK constraint to include 'replied_positive'.
-- Date: 2026-06-12

-- 1. Add identity and review columns to prospects table
ALTER TABLE prospects
ADD COLUMN IF NOT EXISTS source_person_key text NULL,
ADD COLUMN IF NOT EXISTS linkedin_url_normalised text NULL,
ADD COLUMN IF NOT EXISTS country text NULL,
ADD COLUMN IF NOT EXISTS sourcing_review_status text NULL
  CHECK (sourcing_review_status IN ('pending_review', 'approved', 'rejected'));

-- Note: CHECK constraint on sourcing_review_status allowing NULL is Postgres default behaviour.
-- The explicit IS NULL check in the constraint is not needed; Postgres allows NULL by default.

-- 2. Create deduplication indexes
-- Index 1: Prevent duplicate source_person_key per organisation
CREATE UNIQUE INDEX IF NOT EXISTS idx_prospects_source_person_key
  ON prospects(organisation_id, source_person_key)
  WHERE source_person_key IS NOT NULL;

-- Index 2: Prevent duplicate normalised LinkedIn URLs per organisation
CREATE UNIQUE INDEX IF NOT EXISTS idx_prospects_linkedin_url_normalised
  ON prospects(organisation_id, linkedin_url_normalised)
  WHERE linkedin_url_normalised IS NOT NULL;

-- 3. Fix qualification_status CHECK constraint to allow 'replied_positive'
-- Drop the old constraint
ALTER TABLE prospects
DROP CONSTRAINT IF EXISTS prospects_qualification_status_check;

-- Add the new constraint with the additional 'replied_positive' value
ALTER TABLE prospects
ADD CONSTRAINT prospects_qualification_status_check
  CHECK (qualification_status = ANY (ARRAY['qualified'::text, 'flagged_for_review'::text, 'disqualified'::text, 'replied_positive'::text]));

-- 4. Create index on sourcing_review_status for filtering during the sourcing review workflow
CREATE INDEX IF NOT EXISTS idx_prospects_sourcing_review_status
  ON prospects(organisation_id, sourcing_review_status)
  WHERE sourcing_review_status IS NOT NULL;
