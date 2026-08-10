-- Add email_send_ineligible_reason to track why a prospect is not send-eligible
-- Used for country exclusions and other compliance-based send blocks
ALTER TABLE prospects ADD COLUMN email_send_ineligible_reason TEXT DEFAULT NULL;

-- Index for filtering excluded prospects
CREATE INDEX idx_prospects_send_ineligible_reason ON prospects (email_send_ineligible_reason);
