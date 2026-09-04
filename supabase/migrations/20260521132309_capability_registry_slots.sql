-- ADR-024 Prompt 3A — Commit 8
-- Register can_upload_leads and can_order_mailboxes capability slots.
-- Both start is_active=false: handlers are not yet built.
--
-- AMENDED 2026-09-04. This file was the THIRD unguarded whole-object writer and was
-- never named in any earlier audit. It carried DO UPDATE SET config = EXCLUDED.config,
-- so a replay replaced both rows' entire config object with '{}'.
--
-- Neither row's value has diverged from this seed yet, which is exactly why it was
-- missed: there is nothing to see until somebody flips one. The day can_upload_leads or
-- can_order_mailboxes is turned on, or gains a config key, an unguarded DO UPDATE here
-- reverts it silently. Guarding a value BEFORE it diverges is the only time the guard is
-- free. See 20260420_seed_integrations_registry.sql for the full reasoning and the
-- measured evidence.

INSERT INTO integrations_registry (capability, tool_name, is_active, api_handler_ref, config)
VALUES
  ('can_upload_leads',    'instantly', false, 'src/lib/integrations/handlers/instantly/leads', '{}'),
  ('can_order_mailboxes', 'instantly', false, 'src/lib/integrations/handlers/instantly/dfy',   '{}')
ON CONFLICT (capability, tool_name) DO NOTHING;
