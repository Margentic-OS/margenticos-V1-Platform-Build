-- Session 5, Part 1 — Task 1
-- Seed integrations_registry with all phase 1 tools.
-- api_handler_ref points to where each handler will live once built.
-- See ADR-001: tool-agnostic capability registry.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- AMENDED 2026-09-04. THIS FILE USED TO SAY "Safe to re-run" AND IT WAS NOT.
--
-- It carried ON CONFLICT ... DO UPDATE SET config = EXCLUDED.config, which is a
-- WHOLE-OBJECT WRITE: every replay replaced the entire config jsonb with the literal
-- below, deleting any key added later by any other migration or by a person.
--
-- MEASURED, not reasoned about. Replaying the ordered migrations over the live values
-- in a scratch database produced this sequence for can_enrich_contact.config:
--
--   start                                    {"enrichment_live": true}
--   THIS FILE                                {}                          <-- key deleted
--   20260810_enrichment_live_flag.sql        {"enrichment_live": false}
--
-- 20260810 is CORRECT and guarded: it writes only WHERE the key IS NULL. Its guard was
-- defeated because this file had already deleted the key, so the guard matched. A guard
-- on the migration that OWNS a value cannot protect that value from an EARLIER file
-- that wipes the object it lives in.
--
-- TWO CHANGES, both narrow:
--   1. DO UPDATE -> DO NOTHING. The seed now only ever fills a row that is missing. It
--      can no longer revert anything, on any path, for any key, including keys added
--      after this file was written.
--   2. can_enrich_contact.config carries the CURRENT value rather than '{}', so a
--      rebuild from these files lands a working system instead of a reverted one.
--
-- WHY DO NOTHING AND NOT A SMARTER UPSERT. A migration is a history. Making it assert
-- current state on every run means the file stops saying what happened. DO NOTHING says
-- exactly what is intended: this is the value a FRESH database starts from, and an
-- existing database is never touched.
--
-- THE RESIDUAL GAP, ACCEPTED AND STATED. A live value changed and never mirrored back
-- into this literal means a rebuild lands the old value. That is smaller than a replay
-- reverting a live decision, and it is what a drift check would catch. See BACKLOG.

ALTER TABLE integrations_registry
  ADD CONSTRAINT integrations_registry_capability_tool_name_key
  UNIQUE (capability, tool_name);

INSERT INTO integrations_registry (capability, tool_name, is_active, api_handler_ref, config)
VALUES
  ('can_send_email',             'instantly',   true,  'src/lib/handlers/instantly',   '{}'),
  ('can_schedule_linkedin_post', 'taplio',      true,  'src/lib/handlers/taplio',      '{}'),
  ('can_send_linkedin_dm',       'lemlist',     true,  'src/lib/handlers/lemlist',     '{}'),
  -- config was '{}' until 2026-09-04. enrichment_live has been true live since
  -- 2026-08-25; carrying it here is what makes a rebuild land a working system.
  ('can_enrich_contact',         'apollo',      false, 'src/lib/handlers/apollo',      '{"enrichment_live": true}'),
  ('can_book_meeting',           'calendly',    true,  'src/lib/handlers/calendly',    '{}'),
  ('can_track_meeting',          'gohighlevel', true,  'src/lib/handlers/gohighlevel', '{}'),
  ('can_validate_email',         'hunter',      false, 'src/lib/handlers/hunter',      '{}')
ON CONFLICT (capability, tool_name) DO NOTHING;
