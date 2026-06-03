-- Adds revision support to strategy_documents and fixes the segment-aware
-- archival regression introduced in 20260603_strategy_docs_client_approval.sql.
--
-- Three changes:
--   1. Add revision_note + change_summary columns to strategy_documents.
--   2. Create promote_strategy_doc_version() — a shared helper that owns the
--      segment-scoped, NULL-safe archival predicate. Both approve_document_suggestion
--      and the client revision endpoint (via RPC) call this function, so the
--      predicate lives in exactly one place and cannot drift.
--   3. Restore segment-aware approve_document_suggestion (regression fix).
--      The chunk-1 migration overwrote 20260603_segments_approve_function.sql's
--      segment-aware version; this merges both sets of changes and delegates
--      archival to promote_strategy_doc_version.

BEGIN;

-- ── 1. Revision columns ───────────────────────────────────────────────────────
ALTER TABLE public.strategy_documents
  ADD COLUMN revision_note  text NULL,
  ADD COLUMN change_summary text NULL;

-- ── 2. Shared archival helper ─────────────────────────────────────────────────
-- Segment-scoped, NULL-safe archival + version increment + insert.
-- IS NOT DISTINCT FROM ensures NULL = NULL for org-level docs (positioning, tov).
-- Called from approve_document_suggestion and from the revision endpoint via RPC.

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

  -- Archive the current active document for this org + doc_type + segment (NULL-safe).
  UPDATE strategy_documents
  SET status = 'archived', last_updated_at = now()
  WHERE organisation_id = p_org_id
    AND document_type   = p_doc_type
    AND segment_id IS NOT DISTINCT FROM p_segment_id
    AND status          = 'active';

  -- Insert new active version.
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
    client_approval_status,
    pending_since,
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
    'pending',
    now(),
    p_revision_note,
    p_change_summary
  )
  RETURNING * INTO v_new_doc;

  RETURN to_jsonb(v_new_doc);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.promote_strategy_doc_version(uuid, text, uuid, jsonb, text, text, text) FROM PUBLIC;

-- ── 3. Restore segment-aware approve_document_suggestion ──────────────────────
-- Delegates archival + insert to promote_strategy_doc_version.
-- segment_id from the suggestion row drives correct scoping.

CREATE OR REPLACE FUNCTION public.approve_document_suggestion(p_suggestion_id uuid, p_reviewer_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET row_security TO 'off'
AS $function$
DECLARE
  v_suggestion record;
  v_content    jsonb;
  v_new_doc    jsonb;
BEGIN
  SELECT * INTO v_suggestion
  FROM document_suggestions
  WHERE id = p_suggestion_id AND status = 'pending'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Suggestion % not found or not in pending status', p_suggestion_id;
  END IF;

  BEGIN
    v_content := v_suggestion.suggested_value::jsonb;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'suggested_value is not valid JSON for suggestion %', p_suggestion_id;
  END;

  IF v_suggestion.document_type = 'messaging' THEN
    IF v_content -> 'variants' IS NULL THEN
      RAISE EXCEPTION 'Messaging suggestion % is missing the variants key in suggested_value', p_suggestion_id;
    END IF;
  END IF;

  -- Delegate archival + versioning + insert to the shared helper.
  SELECT promote_strategy_doc_version(
    v_suggestion.organisation_id,
    v_suggestion.document_type,
    v_suggestion.segment_id,
    v_content,
    'signal_suggestion',
    NULL,
    NULL
  ) INTO v_new_doc;

  UPDATE document_suggestions
  SET
    status      = 'approved',
    reviewed_at = now(),
    reviewed_by = p_reviewer_id
  WHERE id = p_suggestion_id;

  RETURN v_new_doc;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.approve_document_suggestion(uuid, uuid) FROM PUBLIC;

COMMIT;
