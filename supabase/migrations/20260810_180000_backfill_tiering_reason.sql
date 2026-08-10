-- Backfill tiering_reason for 28 existing tiered prospects
-- Assignment based on their sourced_tier (conservative, tier-consistent)
UPDATE prospects
SET tiering_reason = CASE
  WHEN sourced_tier = 'tier_1' THEN 'tier_1_strict_match'
  WHEN sourced_tier = 'tier_2' THEN 'tier_2_loosened_match'
  WHEN sourced_tier = 'tier_3' THEN 'tier_3_loosened_match_tam_allowed'
END
WHERE sourced_tier IS NOT NULL
  AND tiering_reason IS NULL;
