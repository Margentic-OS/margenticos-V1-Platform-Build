-- 20260512_faq_rls_operator_policies.sql
-- Closes RLS gap on faqs and faq_extractions, and adds append_faq_variant().
--
-- Context:
--   20260501_reply_handling_phase2.sql created both tables with RLS ENABLED
--   but added no access policies — operator routes used service role (bypasses RLS).
--   This migration closes that deferred item (Group 7 build, 2026-05-12).
--
-- Pre-existing state at migration time:
--   faqs: has operators_full_access_faqs (using is_operator()) — created outside migrations
--   faq_extractions: zero policies
--   is_operator(): exists — SELECT EXISTS (SELECT 1 FROM users WHERE id=auth.uid() AND role='operator')
--   append_faq_variant: does not exist
--
-- What this migration adds:
--   1. clients_cannot_access_faqs — restrictive policy on faqs (belt-and-braces)
--   2. operators_full_access_faq_extractions — operator ALL policy
--   3. clients_cannot_access_faq_extractions — restrictive belt-and-braces
--   4. append_faq_variant(p_faq_id, p_new_variant) — atomic jsonb array append
--
-- ADR-003: multi-tenant isolation via RLS.
-- ADR-021: operator policies are cross-org (no organisation_id filter in USING clause).

BEGIN;

-- ── 1. clients_cannot_access_faqs ─────────────────────────────────────────────

CREATE POLICY clients_cannot_access_faqs
  ON faqs
  FOR ALL
  TO authenticated
  USING (false);

-- ── 2. faq_extractions policies ───────────────────────────────────────────────

CREATE POLICY operators_full_access_faq_extractions
  ON faq_extractions
  FOR ALL
  TO authenticated
  USING (is_operator())
  WITH CHECK (is_operator());

CREATE POLICY clients_cannot_access_faq_extractions
  ON faq_extractions
  FOR ALL
  TO authenticated
  USING (false);

-- ── 3. append_faq_variant ─────────────────────────────────────────────────────
-- Atomically appends one variant string to faqs.question_variants (jsonb array).
-- Called from /api/operator/faq-extractions/[id]/approve-merge via supabase.rpc().
-- SECURITY DEFINER: executes as function owner (bypasses per-row RLS for the update).
-- Single UPDATE statement — no read-then-write in application code.
-- Two concurrent approve-merge calls into the same FAQ both succeed atomically.

CREATE OR REPLACE FUNCTION append_faq_variant(
  p_faq_id uuid,
  p_new_variant text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE faqs
  SET
    question_variants = question_variants || jsonb_build_array(p_new_variant),
    updated_at        = now()
  WHERE id = p_faq_id;
END;
$$;

COMMIT;
