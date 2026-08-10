-- Add enrichment_live flag to enrichment capability config
-- Default: false (safe mode, test enrichment)
-- When true: use live Apollo API (real enrichment)

UPDATE integrations_registry
SET config = jsonb_set(
  COALESCE(config, '{}'::jsonb),
  '{enrichment_live}',
  'false'::jsonb
)
WHERE capability = 'can_enrich_contact'
  AND (config IS NULL OR config->>'enrichment_live' IS NULL);
