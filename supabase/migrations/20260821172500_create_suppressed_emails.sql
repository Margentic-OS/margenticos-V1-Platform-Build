-- Migration: create suppressed_emails
-- Date: 2026-08-21
-- Closes audit finding D2: bounce and unsubscribe detection was correct as of fcb2f94
-- and consumed by nothing. This is the list it feeds and the gate that reads it.
--
-- Status: APPLIED (verified live 2026-08-21)
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS IS
--
-- A GLOBAL do-not-contact list, keyed on email address, separate from
-- prospects.suppressed.
--
-- prospects.suppressed is per-row and per-organisation, and it already carries four
-- unrelated meanings: the client rejected this prospect, the research agent
-- disqualified them, they replied with an opt-out, or sourcing dedupe blocked them.
-- Deriving it from this table would destroy all four. It stays exactly as it is.
-- The send gate checks BOTH, in one function. See src/lib/suppression/send-gate.ts.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY GLOBAL, AND HOW TO NARROW IT LATER WITHOUT A MIGRATION
--
-- A hard bounce is a fact about the mailbox, not about the client whose campaign
-- found it. Sending to it again from a different client's campaign burns that
-- client's sending domain for a mailbox we already know is dead.
--
-- An unsubscribe is arguably narrower: the person said "not from you", not
-- "not from anyone". Today both are enforced globally, which is the strict reading.
-- reason and source_org_id are stored on every row precisely so that judgement can
-- change later as a WHERE clause rather than a migration, e.g.
--
--     WHERE revoked_at IS NULL
--       AND (reason = 'bounced' OR source_org_id = <the sending org>)
--
-- The global assumption is therefore hardcoded in exactly ONE place: the query in
-- lookupSuppressedEmails() in src/lib/suppression/suppression-list.ts. Nothing else
-- in the codebase may assume it.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY NO ORG-CONSISTENCY TRIGGER
--
-- faqs, faq_extractions and prospects each carry a BEFORE INSERT OR UPDATE trigger
-- that raises when a referenced row belongs to a different organisation
-- (validate_faqs_org_exists, validate_faq_extractions_org_consistency,
-- check_prospect_campaign_org_match). Those are correct for per-org tables.
--
-- This table MUST NOT inherit that pattern. Its whole purpose is that a row written
-- from organisation A applies when organisation B uploads. An org-matching trigger
-- would be the exact bug the table exists to prevent. Deliberately absent.

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE

CREATE TABLE IF NOT EXISTS suppressed_emails (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Stored lowercase and trimmed, enforced by CHECK below rather than by convention.
  -- If Bob@X.com and bob@x.com can both exist, the same person escapes suppression by
  -- capitalisation. Normalisation happens on write AND on every lookup in
  -- src/lib/suppression/suppression-list.ts; this constraint is the backstop for a
  -- hand-written INSERT that forgets.
  email             text        NOT NULL,

  reason            text        NOT NULL,

  -- Which client's campaign produced this. ON DELETE SET NULL, deliberately NOT
  -- CASCADE: every other organisation-referencing table here cascades, but a global
  -- suppression list must not. Deleting a client would otherwise resurrect their
  -- bounced addresses as sendable. The suppression outlives the organisation; only
  -- the provenance goes null.
  source_org_id     uuid        REFERENCES organisations(id) ON DELETE SET NULL,

  -- Provenance: the signals row that caused this. Nullable, because a suppression can
  -- also be recorded against a signal that was already present (idempotent re-poll),
  -- and because a future manual entry has no signal.
  source_signal_id  uuid        REFERENCES signals(id) ON DELETE SET NULL,

  created_at        timestamptz NOT NULL DEFAULT now(),

  -- Reversibility. An entry is lifted by setting revoked_at, NEVER by deleting the
  -- row. The history stays, so "was this address ever suppressed, and why" always has
  -- an answer.
  revoked_at        timestamptz,
  revoked_reason    text,

  CONSTRAINT suppressed_emails_email_normalised
    CHECK (email = lower(btrim(email))),

  CONSTRAINT suppressed_emails_email_not_blank
    CHECK (length(email) > 0),

  CONSTRAINT suppressed_emails_reason_valid
    CHECK (reason IN ('bounced', 'unsubscribed')),

  -- A revocation without a stated reason is an unexplained lift of a compliance
  -- record. Both fields move together or neither does.
  CONSTRAINT suppressed_emails_revocation_complete
    CHECK (
      (revoked_at IS NULL     AND revoked_reason IS NULL)
      OR
      (revoked_at IS NOT NULL AND revoked_reason IS NOT NULL)
    )
);

-- The suppression itself: one ACTIVE entry per address.
-- Partial on revoked_at IS NULL, so a revoked row does not block a later re-suppression
-- of the same address. A re-bounce after a revoke correctly creates a new active row
-- and leaves the revoked one in place as history.
CREATE UNIQUE INDEX IF NOT EXISTS suppressed_emails_active_unique
  ON suppressed_emails (email)
  WHERE revoked_at IS NULL;

-- Lookup index for the send gate, which queries by a batch of addresses.
CREATE INDEX IF NOT EXISTS suppressed_emails_email_idx
  ON suppressed_emails (email);

-- ─────────────────────────────────────────────────────────────────────────────
-- ACCESS: SERVICE ROLE ONLY
--
-- Same shape as integration_credentials in 20260428_instantly_polling.sql:
-- RLS enabled with ZERO policies, so no authenticated user reaches it at all.
-- Not even operators get a read policy, unlike polling_cursors. There is no
-- client-facing surface for this table and there must never be one.

ALTER TABLE suppressed_emails ENABLE ROW LEVEL SECURITY;

-- No SELECT / INSERT / UPDATE / DELETE policies. Intentional.

-- Supabase grants table privileges to anon and authenticated by default, and RLS with
-- no policies is what actually blocks them. Revoking as well is belt and braces, and
-- the standing rule (CLAUDE.md, learned 2026-06-05) is that every REVOKE ships with an
-- explicit GRANT to each legitimate caller. The only caller is service_role: the poller
-- and the send gate both run with the service client.
REVOKE ALL ON public.suppressed_emails FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.suppressed_emails TO service_role;

-- Verification of the grants above. Expected: t, t, t, f, f.
SELECT
  has_table_privilege('service_role',  'public.suppressed_emails', 'SELECT') AS service_select,
  has_table_privilege('service_role',  'public.suppressed_emails', 'INSERT') AS service_insert,
  has_table_privilege('service_role',  'public.suppressed_emails', 'UPDATE') AS service_update,
  has_table_privilege('authenticated', 'public.suppressed_emails', 'SELECT') AS authenticated_select,
  has_table_privilege('anon',          'public.suppressed_emails', 'SELECT') AS anon_select;

-- ─────────────────────────────────────────────────────────────────────────────
-- HOW TO REVOKE ONE ENTRY (documented, deliberate, never a DELETE)
--
-- Use the TypeScript helper where possible:
--   revokeSuppression(serviceClient, 'Bob@X.com', 'mailbox restored, confirmed by client')
-- It normalises the address for you. By hand, normalise it yourself:
--
--   UPDATE suppressed_emails
--      SET revoked_at     = now(),
--          revoked_reason = 'why this address is safe to contact again'
--    WHERE email          = lower(btrim('Bob@X.com'))
--      AND revoked_at IS NULL;
--
-- The row stays. The next lookup ignores it because the read filters on
-- revoked_at IS NULL. To see the full history of an address, drop that filter.
