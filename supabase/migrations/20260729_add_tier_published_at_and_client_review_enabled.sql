-- Migration: Add tier_published_at to prospects and client_review_enabled to organisations
-- Purpose: Implement operator review gate for prospect tiers before client visibility
--
-- tier_published_at (timestamptz, nullable):
--   - NULL: tier has been classified but NOT reviewed/published by operator yet (prospect hidden from client)
--   - timestamp: operator has published this tier for client review (prospect visible)
--   - Setting: manual (operator clicks "Publish") if client_review_enabled=true
--             automatic at tiering time if client_review_enabled=false
--
-- client_review_enabled (boolean, NOT NULL, default true):
--   - true: operator must manually publish tiers; prospects start with tier_published_at=NULL
--   - false: bypass review gate; tiering auto-sets tier_published_at=now() + auto-approves prospects
--   - Allows optional client-review step via config, not hardcoded

BEGIN;

-- ── 1. Add tier_published_at to prospects ──────────────────────────────────
ALTER TABLE prospects
  ADD COLUMN IF NOT EXISTS tier_published_at timestamptz;

-- Index for fast queries filtering by tier_published_at
CREATE INDEX IF NOT EXISTS idx_prospects_tier_published_at
  ON prospects(organisation_id, sourced_tier, tier_published_at)
  WHERE sourced_tier IS NOT NULL;

-- ── 2. Add client_review_enabled to organisations ──────────────────────────
ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS client_review_enabled boolean NOT NULL DEFAULT true;

-- ── 3. Backfill existing organisations to safe default (review enabled) ────
UPDATE organisations
  SET client_review_enabled = true
  WHERE client_review_enabled IS NULL;

COMMIT;
