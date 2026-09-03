-- Make the four approval columns inert without destroying what they recorded.
--
-- Status: APPLIED (verified live 2026-09-03)
--
-- ─── THE CHOICE ───────────────────────────────────────────────────────────────
--
-- Client approval on strategy documents was removed in ADR-047. That left four columns
-- nothing reads and nothing writes. Two bad options and one good one:
--
--   DROP them          irreversible, and approval_source plus approved_at on 30 archived
--                      rows are the only record of whether a past version was approved by
--                      the operator, by a client, or by the three-day cron
--   LEAVE them         client_approval_status is NOT NULL DEFAULT 'pending', so every new
--                      row still gets 'pending'. One re-added read and the lead upload
--                      silently blocks again, which is the defect ADR-047 removed
--   THIS               drop the defaults and the NOT NULLs. History survives untouched. A
--                      new row gets NULL, which is not a state anything can gate on
--
-- ─── WHAT WAS ADJUSTED, AND WHY, BECAUSE IT MATTERS ───────────────────────────
--
-- The DDL this implements also dropped the DEFAULT on pending_since while leaving its
-- NOT NULL. That combination BREAKS EVERY PROMOTION: promote_strategy_doc_version stopped
-- naming pending_since in its INSERT on 2026-09-03, so the default was the only thing
-- filling it, and removing the default with NOT NULL still in force makes the insert fail.
--
-- Not reasoned about, measured. Applied inside a DO block that rolled itself back:
--
--   PROBE RESULT: NOT NULL VIOLATION on pending_since — the DDL as written breaks
--   every promotion
--
-- So pending_since drops its NOT NULL as well. Read back afterwards, both directions.
--
-- approval_source was in the original DDL with a DROP DEFAULT. It has no default and is
-- already nullable, so that line was a no-op. It is kept below anyway, harmless and
-- explicit, so the four columns are all named in one place rather than three named here
-- and one left to be remembered.
--
-- approved_at is already nullable with no default. Nothing to do, named in this comment
-- rather than in a no-op statement.
--
-- ─── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────
--
-- The CHECK constraints stay. strategy_docs_client_approval_status_check reads
-- client_approval_status = ANY (ARRAY['pending','approved']), and a CHECK passes on NULL
-- because it only fails on FALSE. So NULL is admitted and the constraint still rejects a
-- third value if anybody ever writes one. Dropping it would remove a guard for nothing.
--
-- Existing rows are not touched. Every value that was there is still there.
--
-- ─── DOWN ─────────────────────────────────────────────────────────────────────
-- UPDATE public.strategy_documents SET client_approval_status = 'approved'
--   WHERE client_approval_status IS NULL;
-- UPDATE public.strategy_documents SET pending_since = created_at WHERE pending_since IS NULL;
-- ALTER TABLE public.strategy_documents
--   ALTER COLUMN client_approval_status SET DEFAULT 'pending',
--   ALTER COLUMN client_approval_status SET NOT NULL,
--   ALTER COLUMN pending_since SET DEFAULT now(),
--   ALTER COLUMN pending_since SET NOT NULL;

BEGIN;

ALTER TABLE public.strategy_documents
  ALTER COLUMN client_approval_status DROP DEFAULT,
  ALTER COLUMN client_approval_status DROP NOT NULL,
  ALTER COLUMN approval_source        DROP DEFAULT,
  ALTER COLUMN pending_since          DROP DEFAULT,
  ALTER COLUMN pending_since          DROP NOT NULL;

COMMIT;
