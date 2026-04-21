-- Update approve_document_suggestion to handle four-variant messaging structure.
--
-- The messaging agent now stores suggested_value as:
--   { "variants": { "A": { "emails": [...] }, "B": {...}, "C": {...}, "D": {...} } }
--
-- The previous branch looked for a top-level "emails" key and stored the bare array.
-- That was the pre-ADR-014 single-sequence format and is now incorrect.
--
-- The new branch:
--   1. Validates that the "variants" key exists
--   2. Stores v_content directly as document content — no sub-key extraction
--
-- All other behaviour is identical: atomic transaction, archive prior version,
-- increment version number, mark suggestion approved.

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
  -- The full { "variants": { "A": { "emails": [...] }, ... } } object is the document content.
  -- (Replaces the old branch that looked for "emails" and stored a bare array — ADR-012 follow-up.)
  IF v_suggestion.document_type = 'messaging' THEN
    IF v_content -> 'variants' IS NULL THEN
      RAISE EXCEPTION 'Messaging suggestion % is missing the variants key in suggested_value', p_suggestion_id;
    END IF;
    -- v_content is already the correct shape. No extraction needed.
  END IF;

  -- Find the highest version for this org + document_type to calculate the next version.
  -- Version is stored as text; FLOOR handles both "1" and "1.0" formats.
  SELECT version INTO v_max_version
  FROM strategy_documents
  WHERE organisation_id = v_suggestion.organisation_id
    AND document_type   = v_suggestion.document_type
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_max_version IS NULL THEN
    v_new_version := 1;
  ELSE
    v_new_version := FLOOR(v_max_version::numeric)::integer + 1;
  END IF;

  -- Archive any currently active document for this org + document_type.
  UPDATE strategy_documents
  SET status = 'archived', last_updated_at = now()
  WHERE organisation_id = v_suggestion.organisation_id
    AND document_type   = v_suggestion.document_type
    AND status          = 'active';

  -- Insert the new active document.
  INSERT INTO strategy_documents (
    organisation_id,
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
