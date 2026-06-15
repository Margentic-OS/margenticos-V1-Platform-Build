-- Add enrichment_locked_at for in-flight lock tracking during enrichment execution.
-- Lock is orthogonal to enrichment_status (which tracks final outcome only).
-- On successful completion, enrichment_status is set to terminal value.
-- If handler crashes mid-run, lock ages and becomes reclaimable after stale threshold (30 min).

BEGIN;

ALTER TABLE prospects
  ADD COLUMN enrichment_locked_at timestamptz NULL;

-- Index for fast lookup of lockable prospects:
-- - not yet locked (enrichment_locked_at IS NULL)
-- - OR stale-locked but still unenriched (enrichment_locked_at < now() - 30 min AND enrichment_status IS NULL)
CREATE INDEX idx_prospects_enrichment_lock_status
  ON prospects(organisation_id, enrichment_locked_at, enrichment_status)
  WHERE enrichment_locked_at IS NULL OR (enrichment_status IS NULL AND enrichment_locked_at < now() - interval '30 minutes');

COMMIT;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
-- ALTER TABLE prospects
--   DROP COLUMN IF EXISTS enrichment_locked_at;
-- DROP INDEX IF EXISTS idx_prospects_enrichment_lock_status;
