-- Phase B: Prospect sourcing schema and capability registration
--
-- A1. Add icp_filter_spec to strategy_documents (jsonb, nullable, backward compatible)
--     Stores the ADR-015 filter spec derived from approved ICP documents.
--     Persisted by persistIcpFilterSpec helper in TypeScript, post-promotion.
--
-- A2. Add sourced_tier and qualified_at to prospects (nullable, with CHECK constraint)
--     sourced_tier IN ('tier_1','tier_2','tier_3'), NULL when prospect not yet sourced
--     qualified_at: timestamp when prospect was assigned a tier by sourcing orchestrator
--
-- A3. Register can_source_prospects capability in integrations_registry
--     Follows existing pattern: capability, tool_name, is_active, api_handler_ref, config
--     Tool is apollo; is_active initially false (mock dispatch ON, no live calls in Phase B)

BEGIN;

-- ── A1. strategy_documents: icp_filter_spec for sourcing ──────────────────────
ALTER TABLE public.strategy_documents
  ADD COLUMN icp_filter_spec jsonb NULL;

-- ── A2. prospects: sourced tier and qualification timestamp ──────────────────
-- sourced_tier IN ('tier_1','tier_2','tier_3'), NULL when prospect not yet sourced
-- qualified_at: timestamp when prospect was assigned a tier (populated at sourcing time)
ALTER TABLE public.prospects
  ADD COLUMN sourced_tier text NULL
    CONSTRAINT prospects_sourced_tier_check
    CHECK (sourced_tier IN ('tier_1','tier_2','tier_3')),
  ADD COLUMN qualified_at timestamptz NULL;

-- ── A3. Register can_source_prospects capability ───────────────────────────
-- Follows existing pattern from 20260420_seed_integrations_registry.sql:
-- (capability, tool_name, is_active, api_handler_ref, config)
INSERT INTO public.integrations_registry (capability, tool_name, is_active, api_handler_ref, config)
VALUES ('can_source_prospects', 'apollo', false, 'src/lib/sourcing/adapter-apollo', '{}')
ON CONFLICT (capability, tool_name) DO NOTHING;

COMMIT;

-- ── ROLLBACK ───────────────────────────────────────────────────────────────
-- ALTER TABLE public.strategy_documents DROP COLUMN IF EXISTS icp_filter_spec;
-- ALTER TABLE public.prospects DROP COLUMN IF EXISTS sourced_tier, DROP COLUMN IF EXISTS qualified_at;
-- DELETE FROM public.integrations_registry WHERE capability = 'can_source_prospects';
