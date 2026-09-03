-- Version history a client can read, and a revert an operator can run.
--
-- Status: APPLIED (verified live 2026-09-03)
--
-- ─── 1. THE RLS WIDENING ──────────────────────────────────────────────────────
--
-- The client policy admitted status in ('active', 'approved') only. Archived rows are
-- every previous version of the client's own documents, and with client approval gone
-- the document page now offers "View previous". Without this the list would be empty
-- for a client and full for an operator, which is the worst of both: the feature would
-- look built and do nothing for the people it is for.
--
-- Widened NARROWLY and deliberately. Same organisation predicate, same table, same
-- command, one extra status. Nothing else in this migration touches any other policy.
--
-- WHAT THIS EXPOSES: a client can now read their own organisation's superseded
-- strategy documents. That is their own history. It is not operator data, it is not
-- another organisation's data, and get_my_organisation_id() is what keeps it that way.
--
-- THE CONSEQUENCE THAT NEEDED CODE CHANGES, recorded here because it is not obvious:
-- code that previously filtered only by organisation and document_type could rely on
-- RLS to hide old versions. It cannot any more. buyer-criterion-view.ts now gates on
-- status = 'active' by itself, and deriveStrategyNavState counts document TYPES rather
-- than rows so a pile of archived rows cannot stand in for a document that is missing.
--
-- ─── 2. THE REVERT ────────────────────────────────────────────────────────────
--
-- Revert makes an OLD version's content live as a NEW version. It does not resurrect
-- the old row. Five regenerations therefore leave five recoverable options, the history
-- keeps growing forwards, and nothing is ever destroyed to recover something.
--
-- It delegates to promote_strategy_doc_version, so the archival predicate, the version
-- arithmetic and the segment scoping live in exactly one place and cannot drift between
-- the two ways a new version can be created.
--
-- ─── DOWN ─────────────────────────────────────────────────────────────────────
-- DROP FUNCTION public.revert_strategy_doc_version(uuid);
-- Restore clients_read_own_active_strategy_docs from supabase/baseline/schema.sql.

BEGIN;

-- ── 1. Widen the client read policy to include their own archived versions ────
DROP POLICY IF EXISTS clients_read_own_active_strategy_docs ON public.strategy_documents;

CREATE POLICY clients_read_own_strategy_docs
  ON public.strategy_documents
  FOR SELECT
  TO authenticated
  USING (
    organisation_id = get_my_organisation_id()
    AND status = ANY (ARRAY['active'::text, 'approved'::text, 'archived'::text])
  );

-- ── 2. Revert ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.revert_strategy_doc_version(p_document_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET row_security TO 'off'
AS $$
DECLARE
  v_source record;
  v_new    jsonb;
BEGIN
  SELECT * INTO v_source
  FROM strategy_documents
  WHERE id = p_document_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Document % not found', p_document_id;
  END IF;

  -- Reverting to the version already live would create a duplicate that says nothing.
  IF v_source.status = 'active' THEN
    RAISE EXCEPTION 'Document % is already the live version', p_document_id;
  END IF;

  -- The note is written here rather than by the caller so that every reverted version
  -- carries one. A version history whose entries cannot be told apart is the thing this
  -- work exists to fix, and a blank note is exactly that.
  SELECT promote_strategy_doc_version(
    v_source.organisation_id,
    v_source.document_type,
    v_source.segment_id,
    v_source.content,
    'revert',
    'Restored version ' || v_source.version || '.',
    'This version is the content of version ' || v_source.version || ', put back unchanged.'
  ) INTO v_new;

  RETURN v_new;
END;
$$;

-- Supabase grants EXECUTE to anon, authenticated and service_role individually on every
-- new function in the public schema, so REVOKE FROM PUBLIC alone is a silent no-op.
-- This function rewrites live client-facing copy: it must be reachable only from a route
-- that has already checked the caller is an operator.
REVOKE ALL ON FUNCTION public.revert_strategy_doc_version(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.revert_strategy_doc_version(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revert_strategy_doc_version(uuid) TO service_role;

COMMIT;
