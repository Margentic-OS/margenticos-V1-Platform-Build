-- 20260616_faq_extractions_add_source.sql
-- Adds source column to faq_extractions for distinguishing seed-generated from reply-extracted FAQs.
--
-- Context:
--   Phase 2 builds FAQ extraction from sent Tier 3 replies (reply_extracted).
--   Phase 2 builds FAQ seeding from intake/strategy documents (seed_generated).
--   Both sources write to faq_extractions for operator curation before approval.
--   The source column allows the curation UI to filter and handle each differently.
--
-- Additive schema change. Existing rows default to 'reply_extracted' (most are currently from extraction).

BEGIN;

ALTER TABLE faq_extractions
  ADD COLUMN source text NOT NULL DEFAULT 'reply_extracted'
                               CHECK (source IN ('seed_generated', 'reply_extracted'));

COMMENT ON COLUMN faq_extractions.source IS
  'Origin of the FAQ candidate: seed_generated (from organisation intake/strategy documents
   at onboarding, before any replies) or reply_extracted (from operator-sent Tier 3 replies).
   Allows curation UI to filter and prioritise each source appropriately.
   Default reply_extracted for backcompat with existing rows.';

-- Index for curation filtering: pending extractions by source
CREATE INDEX IF NOT EXISTS idx_faq_extractions_org_status_source
  ON faq_extractions (organisation_id, status, source);

COMMIT;
