-- Backfill .de domain prospects with Germany exclusion reason
-- These prospects have .de email domains but null country field,
-- so they should be marked as ineligible with clear reason
UPDATE prospects
SET
  email_send_eligible = false,
  email_send_ineligible_reason = 'country_excluded_de'
WHERE
  email ILIKE '%.de'
  AND country IS NULL
  AND email_send_eligible = true;
