-- Removes client approval from the document promotion path.
--
-- Status: APPLIED (verified live 2026-09-03)
--
-- ─── WHY ──────────────────────────────────────────────────────────────────────
--
-- promote_strategy_doc_version archived the live document and inserted the
-- replacement with client_approval_status = 'pending'. Every new version therefore
-- passed through a state where it was the live document AND unapproved, and
-- assertStrategyApproved blocks lead upload on exactly that column. So generating a
-- new version stopped outreach until a client clicked Approve or a daily cron
-- decided three days had passed.
--
-- Client approval on strategy documents is removed. The conversation with the
-- operator is the approval. See Decisions Log 2026-09-03 and ADR-039.
--
-- The four approval columns are NOT dropped here. Dropping them is irreversible and
-- is held for its own migration once nothing reads or writes them. After this
-- migration nothing writes them: the INSERT below no longer names them, so the
-- column defaults apply and the values are inert.
--
-- ─── THE OTHER CHANGE: INSERT BEFORE ARCHIVE ──────────────────────────────────
--
-- The archive UPDATE now runs AFTER the INSERT and excludes the row just written.
-- Both statements were already inside one function and therefore one transaction,
-- so this does not close a window that was ever observable from outside. It is
-- ordered this way so that reading the function top to bottom cannot suggest a
-- moment where the organisation has no live document of this type. The new version
-- becomes live, and the previous one archives at that moment, not before.
--
-- ─── DOWN ─────────────────────────────────────────────────────────────────────
-- Restore the definition in 20260603_strategy_docs_revision.sql.

BEGIN;

CREATE OR REPLACE FUNCTION public.promote_strategy_doc_version(
  p_org_id         uuid,
  p_doc_type       text,
  p_segment_id     uuid,
  p_content        jsonb,
  p_update_trigger text,
  p_revision_note  text DEFAULT NULL,
  p_change_summary text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET row_security TO 'off'
AS $$
DECLARE
  v_max_version text;
  v_new_version integer;
  v_new_doc     record;
BEGIN
  -- Version: highest in this org + doc_type + segment lineage (NULL-safe).
  SELECT version INTO v_max_version
  FROM strategy_documents
  WHERE organisation_id = p_org_id
    AND document_type   = p_doc_type
    AND segment_id IS NOT DISTINCT FROM p_segment_id
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_max_version IS NULL THEN
    v_new_version := 1;
  ELSE
    v_new_version := FLOOR(v_max_version::numeric)::integer + 1;
  END IF;

  -- Insert the new active version FIRST. No approval columns: a document is live
  -- because an operator produced it, and there is no second state to clear.
  INSERT INTO strategy_documents (
    organisation_id,
    segment_id,
    document_type,
    version,
    content,
    status,
    generated_at,
    last_updated_at,
    update_trigger,
    revision_note,
    change_summary
  )
  VALUES (
    p_org_id,
    p_segment_id,
    p_doc_type,
    v_new_version::text,
    p_content,
    'active',
    now(),
    now(),
    p_update_trigger,
    p_revision_note,
    p_change_summary
  )
  RETURNING * INTO v_new_doc;

  -- Archive the version it replaces, for this org + doc_type + segment (NULL-safe).
  -- Excludes the row just inserted, which is the only reason the ordering is safe.
  UPDATE strategy_documents
  SET status = 'archived', last_updated_at = now()
  WHERE organisation_id = p_org_id
    AND document_type   = p_doc_type
    AND segment_id IS NOT DISTINCT FROM p_segment_id
    AND status          = 'active'
    AND id             <> v_new_doc.id;

  RETURN to_jsonb(v_new_doc);
END;
$$;

-- Supabase runs ALTER DEFAULT PRIVILEGES granting EXECUTE to anon, authenticated and
-- service_role on every function created in the public schema. Those are individual
-- grants, so REVOKE FROM PUBLIC alone is a silent no-op. Name the roles.
REVOKE ALL ON FUNCTION public.promote_strategy_doc_version(uuid, text, uuid, jsonb, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.promote_strategy_doc_version(uuid, text, uuid, jsonb, text, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.promote_strategy_doc_version(uuid, text, uuid, jsonb, text, text, text) TO service_role;

COMMIT;
