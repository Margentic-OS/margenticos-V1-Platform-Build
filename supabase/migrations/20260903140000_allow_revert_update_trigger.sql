-- Let a version record that it was produced by a revert.
--
-- Status: APPLIED (verified live 2026-09-03)
--
-- ─── HOW THIS WAS FOUND ───────────────────────────────────────────────────────
--
-- By running the revert, on a real organisation, against the real database. Not by
-- reading the code.
--
--   revert failed: new row for relation "strategy_documents" violates check constraint
--   "strategy_documents_update_trigger_check"
--
-- strategy_documents.update_trigger has an allowed-values CHECK, and
-- revert_strategy_doc_version writes 'revert', which was not one of them. The function
-- was correct, the migration that introduced it never touched the constraint, and nothing
-- in the type system or the test suite could see the gap: update_trigger is text on both
-- sides, and the constraint lives only in the database.
--
-- This is the producer-and-consumer-disagreeing shape from CLAUDE.md, with the database
-- as the consumer. The lesson it repeats is the same one: a value crossing a seam needs a
-- test that exercises the PAIR, and the only thing that exercises this pair is running it.
--
-- WHY 'revert' RATHER THAN REUSING 'manual'. A reverted version is not hand-edited and
-- did not come from a signal or a client request. describeVersion in
-- src/lib/dashboard/version-history.ts renders "An earlier version put back" from this
-- value, and that sentence is only true if the value means what it says.
--
-- ─── DOWN ─────────────────────────────────────────────────────────────────────
-- ALTER TABLE public.strategy_documents DROP CONSTRAINT strategy_documents_update_trigger_check;
-- ALTER TABLE public.strategy_documents ADD CONSTRAINT strategy_documents_update_trigger_check
--   CHECK (update_trigger = ANY (ARRAY['initial','signal_suggestion','intake_update','manual','client_revision']));

BEGIN;

ALTER TABLE public.strategy_documents
  DROP CONSTRAINT IF EXISTS strategy_documents_update_trigger_check;

ALTER TABLE public.strategy_documents
  ADD CONSTRAINT strategy_documents_update_trigger_check
  CHECK (update_trigger = ANY (ARRAY[
    'initial'::text,
    'signal_suggestion'::text,
    'intake_update'::text,
    'manual'::text,
    'client_revision'::text,
    'revert'::text
  ]));

COMMIT;
