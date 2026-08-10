-- Add tiering_reason column to track tier verdicts and rejection reasons
ALTER TABLE prospects ADD COLUMN tiering_reason TEXT DEFAULT NULL;

-- Index for filtering by reason in analytics
CREATE INDEX idx_prospects_tiering_reason ON prospects (tiering_reason);
