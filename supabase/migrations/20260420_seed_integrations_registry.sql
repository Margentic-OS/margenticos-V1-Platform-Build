-- Session 5, Part 1 — Task 1
-- Seed integrations_registry with all phase 1 tools.
-- Safe to re-run: uses ON CONFLICT upsert on (capability, tool_name).
-- api_handler_ref points to where each handler will live once built.
-- See ADR-001: tool-agnostic capability registry.

ALTER TABLE integrations_registry
  ADD CONSTRAINT integrations_registry_capability_tool_name_key
  UNIQUE (capability, tool_name);

INSERT INTO integrations_registry (capability, tool_name, is_active, api_handler_ref, config)
VALUES
  ('can_send_email',             'instantly',   true,  'src/lib/handlers/instantly',   '{}'),
  ('can_schedule_linkedin_post', 'taplio',      true,  'src/lib/handlers/taplio',      '{}'),
  ('can_send_linkedin_dm',       'lemlist',     true,  'src/lib/handlers/lemlist',     '{}'),
  ('can_enrich_contact',         'apollo',      true,  'src/lib/handlers/apollo',      '{}'),
  ('can_book_meeting',           'calendly',    true,  'src/lib/handlers/calendly',    '{}'),
  ('can_track_meeting',          'gohighlevel', true,  'src/lib/handlers/gohighlevel', '{}'),
  ('can_validate_email',         'hunter',      false, 'src/lib/handlers/hunter',      '{}')
ON CONFLICT (capability, tool_name)
DO UPDATE SET
  is_active       = EXCLUDED.is_active,
  api_handler_ref = EXCLUDED.api_handler_ref,
  config          = EXCLUDED.config,
  updated_at      = now();
