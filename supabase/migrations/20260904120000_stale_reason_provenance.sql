-- Status: APPLIED (verified live 2026-09-04, production and margenticos-baseline-restore-test)
-- Provenance for the is_stale flag on strategy_documents.
--
-- is_stale has always been a bare boolean. selectStaleDocuments therefore has to INFER what
-- made a document stale, which it does from the document dependency graph: it says "Written
-- before the latest <upstream document>". That sentence is correct for the only writer that
-- existed, promote_strategy_doc_version, which flags downstream documents when an upstream
-- one changes.
--
-- It stops being correct the moment anything else can set the flag. An intake answer changing
-- is not an upstream DOCUMENT changing, and for the prospect profile there is no upstream
-- document at all, so the inferred sentence would be wrong in both wording and substance.
-- stale-documents.ts already records this: "A guess presented as a fact is worse than the
-- honest, shorter sentence."
--
-- So this column carries WHY, written by whoever sets the flag. NULL means the pre-existing
-- document-to-document path, which keeps its inferred sentence unchanged. No backfill: NULL
-- is the correct value for every existing row, because none of them was flagged for any other
-- reason.
--
-- Additive and nullable, so currently-deployed code that does not select it is unaffected.

ALTER TABLE public.strategy_documents
  ADD COLUMN IF NOT EXISTS stale_reason text;

COMMENT ON COLUMN public.strategy_documents.stale_reason IS
  'Why is_stale was set. NULL means an upstream document changed (promote_strategy_doc_version, '
  'which infers its own wording). A non-null value names a different cause, currently only '
  'intake_answer_changed:<field_key>. Never shown raw to a client; stale-documents.ts maps it '
  'to client-facing wording.';
