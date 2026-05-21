-- ADR-024 Prompt 3A — Commit 8
-- Register can_upload_leads and can_order_mailboxes capability slots.
-- Both start is_active=false: handlers are not yet built.
-- Safe to re-run: uses ON CONFLICT upsert on (capability, tool_name).

INSERT INTO integrations_registry (capability, tool_name, is_active, api_handler_ref, config)
VALUES
  ('can_upload_leads',    'instantly', false, 'src/lib/integrations/handlers/instantly/leads', '{}'),
  ('can_order_mailboxes', 'instantly', false, 'src/lib/integrations/handlers/instantly/dfy',   '{}')
ON CONFLICT (capability, tool_name)
DO UPDATE SET
  is_active       = EXCLUDED.is_active,
  api_handler_ref = EXCLUDED.api_handler_ref,
  config          = EXCLUDED.config,
  updated_at      = now();
