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
--
-- ═════════════════════════════════════════════════════════════════════════════
-- AMENDED 2026-09-04. THE MOST CONSEQUENTIAL OF THE THREE WHOLE-OBJECT WRITERS.
--
-- This file carried DO UPDATE SET is_active = EXCLUDED.is_active. instantly_api_active
-- has been TRUE live since 2026-08-16. Measured in a scratch replay over the live
-- values: this file flipped it back to false.
--
-- WHY THAT IS THE WORST ONE. The failure is silent in the direction that looks fine.
-- Sending stops, nothing errors, and the dashboard reads exactly as it does on a quiet
-- day. There is no alert that distinguishes "blocked" from "nothing to send".
--
-- instantly_api_active now carries TRUE, its live value, and the conflict clause is
-- DO NOTHING, so a rebuild lands a sending system and a re-run never reverts one.
--
-- apollo_api_active and instantly_api_mode keep the values they have always had, which
-- are also their live values. They are NOT reclassified here and no live value is
-- changed. They get the same DO NOTHING guard so that a future flip of either is
-- protected on the day it happens rather than after it is discovered.

INSERT INTO integrations_registry (capability, tool_name, is_active, api_handler_ref, config)
VALUES
  -- false until 2026-09-04. Live value has been true since 2026-08-16.
  ('instantly_api_active', 'instantly', true,  'internal/feature-flag', '{}'),
  ('apollo_api_active',    'apollo',    false, 'internal/feature-flag', '{}'),
  ('instantly_api_mode',   'instantly', false, 'internal/feature-flag', '{"mode":"mock"}')
ON CONFLICT (capability, tool_name) DO NOTHING;
