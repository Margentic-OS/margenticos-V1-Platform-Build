-- 20260501_reply_handling_phase2.sql
-- Phase 2 reply handling schema: FAQ knowledge base, draft triage queue, and FAQ extraction loop.
--
-- What this migration does:
--   1. Creates faqs table — approved Q&A knowledge base per organisation
--   2. Creates reply_drafts table — Tier 2/3 drafts awaiting operator review
--   3. Creates faq_extractions table — FAQ candidates extracted from sent Tier 3 replies
--   4. Adds FK constraint on reply_handling_actions.faq_entry_id → faqs(id)
--      (column was created in 20260429_reply_handling.sql; FK deferred until this table existed)
--
-- Architecture context (ADR-019):
--   Tier 2 — AI drafts for operator approval (positive_passive, objection_mild,
--              information_request_* with FAQ match, positive_direct_booking [0.70,0.90))
--   Tier 3 — starting-point only, always needs operator rewrite
--              (information_request_commercial, information_request_generic with no FAQ match,
--               unclear, anything else not auto-actioned and not Tier 2)
--   Compounding loop: operator's Tier 3 sent answers → faq_extractions → curated into faqs
--              → future similar questions route to Tier 2 instead of Tier 3
--   FAQ matcher is deterministic (keyword + normalisation), no LLM per ADR-018.
--
-- RLS pattern (all three tables):
--   RLS is enabled. Service role bypasses by default — all writes are via service role.
--   No authenticated-user policies in this migration. These tables are operator-only.
--   Operator SELECT policies will be added in the triage UI group (Phase 2 Group 3)
--   when the API routes are built. The operator view will use service role reads until then.
--
-- ATOMICITY: Wrapped in BEGIN / COMMIT. All DDL is transactional in Postgres 17.

BEGIN;

-- ── 1. faqs ───────────────────────────────────────────────────────────────────
--
-- Canonical approved Q&A knowledge base per organisation.
-- Written by operators curating faq_extractions. Read by the FAQ matcher (deterministic).
-- Matcher hot path: (organisation_id, status) — filters approved FAQs for an org.
-- Dedupe path on curation: (organisation_id, question_canonical) — prevents duplicates.
--
-- question_variants: array of strings — alt phrasings seen in real replies.
--   Built up as operators approve extractions. Drives keyword matching breadth.
-- source_signal_ids: array of signal uuids — traceability from FAQ back to originating replies.
-- times_used: incremented when an FAQ is selected as draft context for a Tier 2 draft.
--   Identifies most-relied-upon FAQs at a glance for operator maintenance.

CREATE TABLE IF NOT EXISTS faqs (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id     uuid        NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  question_canonical  text        NOT NULL,
  question_variants   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  answer              text        NOT NULL,
  source_signal_ids   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  status              text        NOT NULL DEFAULT 'approved'
                                  CHECK (status IN ('approved', 'archived')),
  times_used          integer     NOT NULL DEFAULT 0,
  last_used_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by_user_id  uuid        REFERENCES auth.users(id)
);

ALTER TABLE faqs ENABLE ROW LEVEL SECURITY;

-- Matcher hot path: approved FAQs for a given org.
CREATE INDEX IF NOT EXISTS idx_faqs_org_status
  ON faqs (organisation_id, status);

-- Dedupe check during operator curation.
CREATE INDEX IF NOT EXISTS idx_faqs_org_question_canonical
  ON faqs (organisation_id, question_canonical);

-- ── 2. reply_drafts ───────────────────────────────────────────────────────────
--
-- Drafted reply bodies (Tier 2 and Tier 3) awaiting operator review.
-- Created by the reply-draft-agent (Phase 2 Group 2 — not built yet).
-- One draft per signal — enforced by UNIQUE on signal_id.
--
-- ai_draft_body: immutable after write — what the agent generated, never mutated.
--   Preserves the unedited draft for audit and future quality analysis.
-- final_sent_body: set at send time. Null until then. Equals ai_draft_body if no edit.
-- draft_metadata (jsonb):
--   Tier 2 fields: { faq_ids_used: string[], confidence_at_draft: number }
--   Tier 3 fields: { ambiguity_note: string, alternative_directions: string[] }
-- edited_at: set on first edit only; null if operator approved without changes.
-- instantly_message_id: populated by sendThreadReply on successful send.
-- send_error: populated if status = 'send_failed'; null on success.
--
-- UNIQUE on signal_id: the reply-draft-agent checks for an existing draft before
--   writing (idempotency). The UNIQUE constraint is a belt-and-braces safety net.

CREATE TABLE IF NOT EXISTS reply_drafts (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id       uuid        NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  signal_id             uuid        NOT NULL REFERENCES signals(id) ON DELETE CASCADE UNIQUE,
  prospect_id           uuid        REFERENCES prospects(id),
  tier                  integer     NOT NULL CHECK (tier IN (2, 3)),
  intent                text        NOT NULL,
  ai_draft_body         text        NOT NULL,
  final_sent_body       text,
  draft_metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status                text        NOT NULL DEFAULT 'pending'
                                    CHECK (status IN ('pending', 'approved', 'rejected', 'sent', 'send_failed')),
  reviewed_by_user_id   uuid        REFERENCES auth.users(id),
  reviewed_at           timestamptz,
  edited_at             timestamptz,
  edited_by_user_id     uuid        REFERENCES auth.users(id),
  sent_at               timestamptz,
  send_error            text,
  instantly_message_id  text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE reply_drafts ENABLE ROW LEVEL SECURITY;

-- Triage view: pending drafts for an org, newest first.
CREATE INDEX IF NOT EXISTS idx_reply_drafts_org_status_created
  ON reply_drafts (organisation_id, status, created_at DESC);

-- Cross-org operator queue: all pending drafts regardless of org.
CREATE INDEX IF NOT EXISTS idx_reply_drafts_pending_status
  ON reply_drafts (status)
  WHERE status = 'pending';

-- ── 3. faq_extractions ────────────────────────────────────────────────────────
--
-- Pending FAQ candidates extracted from sent Tier 3 reply bodies, awaiting operator curation.
-- Created by the faq-extraction-agent (Phase 2 Group 2 — not built yet).
-- Created AFTER a Tier 3 draft is sent (final_sent_body is the extraction source).
--
-- extracted_question: the question the prospect appeared to be asking.
-- suggested_answer: derived from the operator's final_sent_body — the actual reply they sent.
--   This is higher-quality seed material than a generated answer; it IS what the operator said.
-- similar_faq_id: nullable; populated if the FAQ matcher finds an existing FAQ to merge into.
--   If set, curation choice is: approved_merge (add phrasing to existing) vs approved_new.
-- status values:
--   pending       — awaiting operator review in the curation view
--   approved_new  — operator approved as a new standalone FAQ row
--   approved_merge — operator approved as an additional variant on an existing FAQ
--   rejected      — operator decided this is not a useful FAQ candidate
--
-- Curation hot path: pending extractions for an org.
-- Signal trace-back: from a reply_handling_actions or reply_drafts row to its extraction.

CREATE TABLE IF NOT EXISTS faq_extractions (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id       uuid        NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  signal_id             uuid        NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  reply_draft_id        uuid        NOT NULL REFERENCES reply_drafts(id) ON DELETE CASCADE,
  extracted_question    text        NOT NULL,
  suggested_answer      text        NOT NULL,
  similar_faq_id        uuid        REFERENCES faqs(id),
  status                text        NOT NULL DEFAULT 'pending'
                                    CHECK (status IN ('pending', 'approved_new', 'approved_merge', 'rejected')),
  reviewed_by_user_id   uuid        REFERENCES auth.users(id),
  reviewed_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE faq_extractions ENABLE ROW LEVEL SECURITY;

-- Curation view hot path: pending extractions for an org.
CREATE INDEX IF NOT EXISTS idx_faq_extractions_org_status
  ON faq_extractions (organisation_id, status);

-- Signal trace-back.
CREATE INDEX IF NOT EXISTS idx_faq_extractions_signal_id
  ON faq_extractions (signal_id);

-- ── 4. FK constraint on reply_handling_actions.faq_entry_id ──────────────────
--
-- reply_handling_actions.faq_entry_id was created in 20260429_reply_handling.sql
-- with a comment: "FK to faq_entries.id deferred until Phase 2 creates that table".
-- The table is now created above as `faqs` (renamed from the originally planned faq_entries).
-- Adding the FK constraint here closes the deferred reference.

ALTER TABLE reply_handling_actions
  ADD CONSTRAINT fk_reply_handling_actions_faq_id
  FOREIGN KEY (faq_entry_id) REFERENCES faqs(id);

COMMIT;
