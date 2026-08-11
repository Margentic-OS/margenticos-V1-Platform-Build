-- Add operator override capability for flagged prospects
-- Allows operators to override classification decisions with audit trail

ALTER TABLE prospects
ADD COLUMN IF NOT EXISTS operator_override_at timestamptz NULL,
ADD COLUMN IF NOT EXISTS operator_override_by uuid NULL REFERENCES auth.users(id),
ADD COLUMN IF NOT EXISTS operator_override_tier varchar(20) NULL CHECK (operator_override_tier IN ('tier_1', 'tier_2', 'tier_3')),
ADD COLUMN IF NOT EXISTS operator_override_reason text NULL;

-- Index for querying overridden prospects
CREATE INDEX IF NOT EXISTS idx_prospects_operator_override
ON prospects(organisation_id, operator_override_at DESC)
WHERE operator_override_at IS NOT NULL;

-- Comment columns for clarity
COMMENT ON COLUMN prospects.operator_override_at IS 'Timestamp when operator override was applied';
COMMENT ON COLUMN prospects.operator_override_by IS 'User ID of operator who applied override';
COMMENT ON COLUMN prospects.operator_override_tier IS 'Tier assigned by operator override (overrides classification)';
COMMENT ON COLUMN prospects.operator_override_reason IS 'Reason for operator override';
