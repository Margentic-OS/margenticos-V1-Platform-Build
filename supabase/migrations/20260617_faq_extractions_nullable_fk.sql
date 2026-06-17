-- 20260617_faq_extractions_nullable_fk.sql
--
-- Make signal_id and reply_draft_id nullable in faq_extractions.
-- Seed-generated FAQ extractions (from faq-seed-agent at onboarding) have no
-- associated signal or reply_draft, so these FKs must be nullable.
--
-- The org-consistency trigger already handles NULL values gracefully (checks
-- IS NOT NULL before validating FK references), so no trigger changes needed.
--
-- Migration is idempotent (ALTER only if column is NOT NULL).

BEGIN;

-- Drop FK constraints if they exist (necessary to change to nullable)
ALTER TABLE faq_extractions
  DROP CONSTRAINT IF EXISTS faq_extractions_signal_id_fkey;

ALTER TABLE faq_extractions
  DROP CONSTRAINT IF EXISTS faq_extractions_reply_draft_id_fkey;

-- Change columns to nullable
ALTER TABLE faq_extractions
  ALTER COLUMN signal_id DROP NOT NULL;

ALTER TABLE faq_extractions
  ALTER COLUMN reply_draft_id DROP NOT NULL;

-- Re-add FK constraints
ALTER TABLE faq_extractions
  ADD CONSTRAINT faq_extractions_signal_id_fkey
  FOREIGN KEY (signal_id) REFERENCES signals(id) ON DELETE CASCADE;

ALTER TABLE faq_extractions
  ADD CONSTRAINT faq_extractions_reply_draft_id_fkey
  FOREIGN KEY (reply_draft_id) REFERENCES reply_drafts(id) ON DELETE CASCADE;

COMMIT;
