-- Extends the update_trigger check constraint on strategy_documents to include
-- 'client_revision', required by the promote_strategy_doc_version helper when
-- called from the client revision endpoint.

ALTER TABLE public.strategy_documents
  DROP CONSTRAINT strategy_documents_update_trigger_check;

ALTER TABLE public.strategy_documents
  ADD CONSTRAINT strategy_documents_update_trigger_check
  CHECK (update_trigger = ANY (ARRAY[
    'initial'::text,
    'signal_suggestion'::text,
    'intake_update'::text,
    'manual'::text,
    'client_revision'::text
  ]));
