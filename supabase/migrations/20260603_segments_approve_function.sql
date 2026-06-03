-- Segment-aware write path: Step D.
-- Updates approve_document_suggestion to:
--   1. Pass segment_id through to strategy_documents INSERT.
--   2. Scope the archive UPDATE to matching segment (IS NOT DISTINCT FROM — NULL-safe).
--   3. Scope the max-version lookup to the same segment lineage.
--
-- Effect by document type:
--   icp, messaging  → archived and versioned per (org, doc_type, segment_id)
--   positioning, tov → segment_id IS NULL on both sides; IS NOT DISTINCT FROM matches correctly
--
-- ── DOWN (reversal) ───────────────────────────────────────────────────────────
-- Re-apply the previous version from
-- supabase/migrations/20260421_update_approve_document_suggestion_for_variants.sql
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.approve_document_suggestion(p_suggestion_id uuid, p_reviewer_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET row_security TO 'off'
AS $function$
DECLARE
  v_suggestion   record;
  v_content      jsonb;
  v_max_version  text;
  v_new_version  integer;
  v_new_doc      record;
BEGIN
  -- Lock the suggestion row to prevent concurrent approvals of the same suggestion.
  SELECT * INTO v_suggestion
  FROM document_suggestions
  WHERE id = p_suggestion_id AND status = 'pending'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Suggestion % not found or not in pending status', p_suggestion_id;
  END IF;

  -- Parse suggested_value from text to jsonb.
  BEGIN
    v_content := v_suggestion.suggested_value::jsonb;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'suggested_value is not valid JSON for suggestion %', p_suggestion_id;
  END;

  -- For messaging: validate the four-variant structure exists and store v_content directly.
  IF v_suggestion.document_type = 'messaging' THEN
    IF v_content -> 'variants' IS NULL THEN
      RAISE EXCEPTION 'Messaging suggestion % is missing the variants key in suggested_value', p_suggestion_id;
    END IF;
  END IF;

  -- Find the highest version for this org + document_type + segment to calculate next version.
  -- IS NOT DISTINCT FROM is used so NULL = NULL (org-level docs like positioning/tov match correctly).
  SELECT version INTO v_max_version
  FROM strategy_documents
  WHERE organisation_id = v_suggestion.organisation_id
    AND document_type   = v_suggestion.document_type
    AND segment_id IS NOT DISTINCT FROM v_suggestion.segment_id
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_max_version IS NULL THEN
    v_new_version := 1;
  ELSE
    v_new_version := FLOOR(v_max_version::numeric)::integer + 1;
  END IF;

  -- Archive any currently active document for this org + document_type + segment.
  -- IS NOT DISTINCT FROM ensures NULL matches NULL for org-level docs.
  UPDATE strategy_documents
  SET status = 'archived', last_updated_at = now()
  WHERE organisation_id = v_suggestion.organisation_id
    AND document_type   = v_suggestion.document_type
    AND segment_id IS NOT DISTINCT FROM v_suggestion.segment_id
    AND status          = 'active';

  -- Insert the new active document, including segment_id.
  INSERT INTO strategy_documents (
    organisation_id,
    segment_id,
    document_type,
    version,
    content,
    status,
    generated_at,
    last_updated_at,
    update_trigger
  )
  VALUES (
    v_suggestion.organisation_id,
    v_suggestion.segment_id,
    v_suggestion.document_type,
    v_new_version::text,
    v_content,
    'active',
    now(),
    now(),
    'signal_suggestion'
  )
  RETURNING * INTO v_new_doc;

  -- Mark the suggestion approved.
  UPDATE document_suggestions
  SET
    status      = 'approved',
    reviewed_at = now(),
    reviewed_by = p_reviewer_id
  WHERE id = p_suggestion_id;

  RETURN to_jsonb(v_new_doc);
END;
$function$;
