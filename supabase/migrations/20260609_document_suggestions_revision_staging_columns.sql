-- Adds two columns to document_suggestions to support staging client messaging
-- revisions for operator review before they go live.
--
-- revision_note   — the client's free-text note that triggered the revision.
--                   NULL for all existing rows (agent-generated suggestions have
--                   no client note). Populated when a client revision is staged.
--
-- update_trigger  — what caused this suggestion row to be written.
--                   DEFAULT 'signal_suggestion' so all 19 existing columns on
--                   existing rows get the correct retroactive value automatically.
--                   CHECK constraint enforced at DB level because this value drives
--                   rate-limit logic and operator UI rendering.
--
-- No existing rows are modified beyond receiving the default on update_trigger.
-- No existing constraints are dropped or replaced.

ALTER TABLE public.document_suggestions
  ADD COLUMN revision_note  text NULL,
  ADD COLUMN update_trigger text NOT NULL DEFAULT 'signal_suggestion'
    CONSTRAINT document_suggestions_update_trigger_check
    CHECK (update_trigger = ANY (ARRAY[
      'signal_suggestion'::text,
      'client_revision'::text
    ]));
