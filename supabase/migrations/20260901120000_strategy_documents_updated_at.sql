-- strategy_documents.updated_at, maintained by a trigger.
--
-- WHY: an in-place edit to an ACTIVE strategy document moved no timestamp, so the
-- statement "this document has not changed since it was approved" could not be
-- verified against the row. approved_at records when approval happened; nothing
-- recorded whether the content moved afterwards.
--
-- WHAT ABOUT last_updated_at, WHICH ALREADY EXISTS AND LOOKS LIKE THIS COLUMN.
-- It is not a modification timestamp and must not be read as one. Nothing in src/
-- writes it: all eleven references are .select() reads, several of which render it
-- to the client as "updated N ago". Its only writers are SQL functions
-- (approve_document_suggestion and the segment variants), and each writes it on the
-- ARCHIVE step only: `SET status = 'archived', last_updated_at = now()`. So it marks
-- a STATUS TRANSITION, not a content change. Measured 2026-09-01: 37 of 55 rows carry
-- a last_updated_at later than created_at, and those are archivals.
--
-- It is left exactly as it is. Attaching the trigger to it instead would silently
-- change what the client dashboard already displays, which is a behaviour change in a
-- migration about being able to prove a document did not move.
--
-- CONVENTION FOLLOWED, not invented. Seven tables already do this: campaigns,
-- intake_responses, integrations_registry, meetings, organisations, patterns and
-- prospects. Each has `updated_at timestamptz NOT NULL DEFAULT now()` and a
-- `<table>_set_updated_at BEFORE UPDATE ... EXECUTE FUNCTION set_updated_at()`
-- trigger. public.set_updated_at() hardcodes `NEW.updated_at`, so the column name is
-- forced: no other name works with the shared function.
--
-- BACKFILL TO created_at, NOT now(). Backfilling to now() would assert that every
-- existing document was modified at migration time, which is false for all 55 of them.
-- created_at is the last point at which the row's content is known to have been set.
-- last_updated_at is deliberately NOT used as the backfill source, because it records
-- archival rather than modification and would import that wrong meaning into the new
-- column on its first day.
--
-- Status: APPLIED (verified live 2026-09-01)

ALTER TABLE public.strategy_documents
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Existing rows: the column default stamped them all with now() on ADD COLUMN.
-- Correct that to created_at, which is the honest value.
UPDATE public.strategy_documents
   SET updated_at = created_at
 WHERE updated_at <> created_at;

DROP TRIGGER IF EXISTS strategy_documents_set_updated_at ON public.strategy_documents;

CREATE TRIGGER strategy_documents_set_updated_at
  BEFORE UPDATE ON public.strategy_documents
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
