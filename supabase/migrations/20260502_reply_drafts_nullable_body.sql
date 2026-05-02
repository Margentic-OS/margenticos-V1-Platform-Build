-- 20260502_reply_drafts_nullable_body.sql
-- Group 4: reply routing + orchestrator schema changes.
--
-- What this migration does:
--   1. Makes reply_drafts.ai_draft_body nullable so placeholder rows can be written
--      for failure states (manual_required, draft_failed) that need no draft body.
--   2. Expands reply_drafts.status check constraint to include the two new
--      placeholder statuses: 'manual_required' and 'draft_failed'.
--   3. Adds a CHECK constraint enforcing that ai_draft_body is NULL only for
--      placeholder statuses, and NOT NULL for all others.
--   4. Adds signals.original_outbound_body — the body of the email the prospect
--      is replying to. Captured at polling time (not per-draft fetch). Nullable
--      for backward compatibility; NULL triggers manual_required in orchestrator.
--   5. Adds signals.original_outbound_message_id — the Instantly UUID of the
--      original outbound email, for traceability.
--
-- Pre-check (run before applying — verify 0 rows returned):
--   SELECT id, status, ai_draft_body IS NULL AS body_is_null
--   FROM reply_drafts
--   WHERE
--     (status IN ('manual_required', 'draft_failed') AND ai_draft_body IS NOT NULL)
--     OR
--     (status NOT IN ('manual_required', 'draft_failed') AND ai_draft_body IS NULL);
-- Expected result: 0 rows. If any rows returned, stop and surface to Doug.
-- Pre-check result at time of migration: 0 rows (confirmed 2026-05-02).
--
-- ATOMICITY: Wrapped in BEGIN / COMMIT. All DDL is transactional in Postgres 17.

BEGIN;

-- ── 1. reply_drafts: nullable ai_draft_body ────────────────────────────────────

ALTER TABLE reply_drafts ALTER COLUMN ai_draft_body DROP NOT NULL;

-- ── 2. Expand status check constraint ─────────────────────────────────────────

ALTER TABLE reply_drafts DROP CONSTRAINT reply_drafts_status_check;
ALTER TABLE reply_drafts ADD CONSTRAINT reply_drafts_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'sent', 'send_failed',
                    'manual_required', 'draft_failed'));

-- ── 3. Enforce body nullability per status ────────────────────────────────────
-- Placeholder statuses (manual_required, draft_failed) must have NULL body.
-- All other statuses must have a non-NULL body.
-- This constraint makes the schema self-documenting: a NULL body always means
-- "operator action required" and no AI draft was produced.

ALTER TABLE reply_drafts ADD CONSTRAINT reply_drafts_body_required
  CHECK (
    (status IN ('manual_required', 'draft_failed') AND ai_draft_body IS NULL)
    OR
    (status IN ('pending', 'approved', 'rejected', 'sent', 'send_failed') AND ai_draft_body IS NOT NULL)
  );

-- ── 4. signals: original outbound body capture ────────────────────────────────
-- Populated at polling time when a reply signal is ingested.
-- If the Instantly API fetch fails, the signal is still written with NULL.
-- NULL triggers manual_required in the orchestrator (missing context).

ALTER TABLE signals ADD COLUMN original_outbound_body text;
ALTER TABLE signals ADD COLUMN original_outbound_message_id text;

COMMENT ON COLUMN signals.original_outbound_body IS
  'Body of the outbound email this reply is replying to. Captured at polling '
  'time via Instantly API. NULL if fetch failed or field not found in reply object.';

COMMENT ON COLUMN signals.original_outbound_message_id IS
  'Instantly UUID of the original outbound email. Captured at polling time.';

COMMIT;
