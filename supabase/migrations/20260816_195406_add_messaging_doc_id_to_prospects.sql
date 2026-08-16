-- Migration: Add messaging_doc_id to prospects for version tracking
-- Purpose: Record which strategy_documents version was used at composition time
--          so historical attribution remains correct when docs are revised
-- Date: 2026-08-16

BEGIN;

ALTER TABLE prospects
ADD COLUMN IF NOT EXISTS messaging_doc_id uuid NULL;

-- Index for analytics queries on which doc version is in use
CREATE INDEX IF NOT EXISTS idx_prospects_messaging_doc_id
  ON prospects(messaging_doc_id)
  WHERE messaging_doc_id IS NOT NULL;

COMMIT;
