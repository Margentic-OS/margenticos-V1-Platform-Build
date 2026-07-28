-- Phase B: Wire Apollo sourcing handler manifest in integrations_registry
--
-- Adds supported_fields column to integrations_registry and populates Apollo
-- handler with its 12 supported fields. These fields are derived from and verified
-- against the Apollo adapter's query-builder (adapter-apollo.ts:109-191, 255-290).
--
-- Supported fields (12 total):
--   From adapter query-builder: job_titles, seniority_levels, person_countries,
--   company_countries, company_headcount_min, company_headcount_max, industries,
--   keywords, company_revenue_min, company_revenue_max
--   From post-filtering: job_titles_excluded, keywords_excluded
--
-- The manifest gate (orchestrator.ts:116-172) reads handler.supported_fields
-- at TypeScript layer; this DB column supports operator visibility and future
-- registry-driven validation. Both must stay in sync.

BEGIN;

-- Add supported_fields column (text[] array, NULL for backward compatibility)
ALTER TABLE public.integrations_registry
  ADD COLUMN supported_fields text[] NULL;

-- Populate Apollo sourcing handler manifest
UPDATE public.integrations_registry
  SET supported_fields = ARRAY[
    'job_titles',
    'seniority_levels',
    'person_countries',
    'company_countries',
    'company_headcount_min',
    'company_headcount_max',
    'industries',
    'keywords',
    'company_revenue_min',
    'company_revenue_max',
    'job_titles_excluded',
    'keywords_excluded'
  ]::text[]
  WHERE capability = 'can_source_prospects' AND tool_name = 'apollo';

COMMIT;

-- ── ROLLBACK ───────────────────────────────────────────────────────────────
-- ALTER TABLE public.integrations_registry DROP COLUMN IF EXISTS supported_fields;
