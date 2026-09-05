-- 20260905120000_rejected_draft_may_have_no_body.sql
-- Status: APPLIED (verified live 2026-09-05 — production hjpvnvjryxdjcfdsfhzy and test tidqheqjzvwmrrrebzir)
--
-- What this migration does:
--   Relaxes reply_drafts_body_required so a 'rejected' row may have a NULL
--   ai_draft_body. Nothing else about the constraint changes.
--
-- Why:
--   The operator triage queue serves four statuses (pending, manual_required,
--   draft_failed, send_failed) and renders a Reject button on all of them.
--   manual_required and draft_failed rows have ai_draft_body NULL by design:
--   no draft was ever generated. Rejecting one moves it to 'rejected', and the
--   old constraint demanded a non-NULL body for that status, so the write was
--   blocked outright.
--
--   Measured on the test project 2026-09-05, both inside a rolled-back block:
--     widen reject's status list only  ->  BLOCKED by reply_drafts_body_required
--     widen + write a placeholder body ->  SUCCEEDED
--
--   The second option was rejected deliberately. Writing '' into ai_draft_body
--   to satisfy a CHECK would record that an empty draft was produced, which is
--   false: no draft was produced at all. The schema comment on this constraint
--   says a NULL body always means "no AI draft was produced", and that stays
--   true through rejection. The constraint was wrong, not the data.
--
-- What stays enforced:
--   manual_required / draft_failed  ->  body MUST be NULL (unchanged)
--   pending / approved / sent / send_failed -> body MUST be NOT NULL (unchanged)
--   rejected -> either, because both are reachable and both are honest
--
-- Direction of change: this is a RELAXATION. Every row that satisfied the old
-- constraint satisfies the new one, so it is safe to apply ahead of the code
-- that needs it, which is the normal ordering on this project (MCP
-- apply_migration reaches production immediately; deployed code meets the new
-- schema until the branch merges).
--
-- Pre-check (expect 0 rows — any row here already violates the OLD constraint
-- and means something other than this migration is wrong):
--   SELECT id, status FROM reply_drafts
--   WHERE (status IN ('manual_required','draft_failed') AND ai_draft_body IS NOT NULL)
--      OR (status IN ('pending','approved','sent','send_failed') AND ai_draft_body IS NULL);
--
-- Rollback: see the block at the foot of this file. Re-tightening is only safe
-- while no rejected row has a NULL body; once one exists the old constraint
-- cannot be restored without deciding what those rows should contain.
--
-- ATOMICITY: wrapped in BEGIN / COMMIT. All DDL is transactional in Postgres 17.

BEGIN;

ALTER TABLE reply_drafts DROP CONSTRAINT reply_drafts_body_required;

ALTER TABLE reply_drafts ADD CONSTRAINT reply_drafts_body_required
  CHECK (
    (status IN ('manual_required', 'draft_failed') AND ai_draft_body IS NULL)
    OR
    (status IN ('pending', 'approved', 'sent', 'send_failed') AND ai_draft_body IS NOT NULL)
    OR
    -- A draft can be rejected from a status that never had a body
    -- (manual_required, draft_failed) or from one that did (pending,
    -- send_failed). Both are legitimate, so this status constrains neither way.
    (status = 'rejected')
  );

COMMENT ON CONSTRAINT reply_drafts_body_required ON reply_drafts IS
  'ai_draft_body is NULL exactly when no AI draft was produced. Placeholder '
  'statuses require NULL; live statuses require NOT NULL; rejected permits '
  'either, because a row can be rejected from either kind.';

COMMIT;

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- Verify first, and stop if this returns anything other than 0:
--   SELECT count(*) FROM reply_drafts WHERE status = 'rejected' AND ai_draft_body IS NULL;
--
-- BEGIN;
-- ALTER TABLE reply_drafts DROP CONSTRAINT reply_drafts_body_required;
-- ALTER TABLE reply_drafts ADD CONSTRAINT reply_drafts_body_required
--   CHECK (
--     (status IN ('manual_required', 'draft_failed') AND ai_draft_body IS NULL)
--     OR
--     (status IN ('pending', 'approved', 'rejected', 'sent', 'send_failed') AND ai_draft_body IS NOT NULL)
--   );
-- COMMIT;
