-- ADR-024 Prompt 3B — Commit 1
-- Add three feature flag rows to integrations_registry.
--
-- instantly_api_active: false = live Instantly calls blocked; true = live calls permitted.
-- apollo_api_active:    false = live Apollo calls blocked; true = live calls permitted.
-- instantly_api_mode:   is_active mirrors instantly_api_active for consistency.
--   config.mode stores the human-readable state ('mock' | 'production').
--   Handlers read INSTANTLY_API_BASE_URL env var (not this row) for the actual URL.
--   This row exists so operator UI can display the current mode without reading env vars.
--
-- api_handler_ref is NOT NULL with no default; 'internal/feature-flag' marks rows
-- that are configuration flags, not dispatch targets.

INSERT INTO integrations_registry (capability, tool_name, is_active, api_handler_ref, config)
VALUES
  ('instantly_api_active', 'instantly', false, 'internal/feature-flag', '{}'),
  ('apollo_api_active',    'apollo',    false, 'internal/feature-flag', '{}'),
  ('instantly_api_mode',   'instantly', false, 'internal/feature-flag', '{"mode":"mock"}')
ON CONFLICT (capability, tool_name)
DO UPDATE SET
  is_active       = EXCLUDED.is_active,
  api_handler_ref = EXCLUDED.api_handler_ref,
  config          = EXCLUDED.config,
  updated_at      = now();
