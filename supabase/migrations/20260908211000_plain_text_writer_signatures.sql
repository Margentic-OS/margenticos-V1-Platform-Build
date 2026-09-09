-- Gives promote_strategy_doc_version a plain_text parameter, and carries the recording
-- model through the two functions that call it.
--
-- Status: PENDING (apply via Supabase MCP apply_migration, then mark APPLIED)
--
-- SPLIT FROM 20260908210000_document_model_columns.sql DELIBERATELY. That migration is
-- purely additive (two nullable columns) and was applied on its own. This one CHANGES TWO
-- FUNCTION SIGNATURES and therefore has to DROP the superseded overloads, which is a
-- destructive operation under the MCP safety rules and needs explicit approval before it
-- runs. Keeping the two apart means the additive half is not held hostage to that approval,
-- and the destructive half is a single reviewable file rather than a clause buried at the
-- bottom of a longer one.
--
-- WHY THE DROPS ARE NOT OPTIONAL. Adding defaulted parameters creates a NEW function rather
-- than replacing the old one, so both overloads would exist. Two consequences, and the
-- second is worse than the first:
--
--   1. A two-argument call to approve_document_suggestion becomes AMBIGUOUS and Postgres
--      raises 'function is not unique'. Approvals would break outright.
--   2. Worse, a call that DOES resolve to the old overload silently writes plain_text NULL,
--      so the defect would survive its own fix. That is the shape CLAUDE.md records for the
--      monitor sweep, whose fix added a view name to one array and not the code to the
--      other, and whose commit message asserted otherwise.
--
-- The drops are LAST, so a failure earlier in this file leaves the working originals in
-- place rather than removing them ahead of their replacements.

-- ─── Part 1 + 2: promote_strategy_doc_version ───────────────────────────────
--
-- Two new trailing parameters, both defaulted, so existing call sites still resolve.

CREATE OR REPLACE FUNCTION public.promote_strategy_doc_version(
  p_org_id           uuid,
  p_doc_type         text,
  p_segment_id       uuid,
  p_content          jsonb,
  p_update_trigger   text,
  p_revision_note    text DEFAULT NULL::text,
  p_change_summary   text DEFAULT NULL::text,
  p_plain_text       text DEFAULT NULL::text,
  p_generated_by_model text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET row_security TO 'off'
AS $function$
DECLARE
  v_max_version text;
  v_new_version integer;
  v_new_doc     record;
BEGIN
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

  INSERT INTO strategy_documents (
    organisation_id, segment_id, document_type, version, content, status,
    generated_at, last_updated_at, update_trigger, revision_note, change_summary,
    plain_text, generated_by_model
  )
  VALUES (
    p_org_id, p_segment_id, p_doc_type, v_new_version::text, p_content, 'active',
    now(), now(), p_update_trigger, p_revision_note, p_change_summary,
    p_plain_text, p_generated_by_model
  )
  RETURNING * INTO v_new_doc;

  UPDATE strategy_documents
  SET status = 'archived', last_updated_at = now()
  WHERE organisation_id = p_org_id
    AND document_type   = p_doc_type
    AND segment_id IS NOT DISTINCT FROM p_segment_id
    AND status          = 'active'
    AND id             <> v_new_doc.id;

  -- Mark the downstream documents stale. Flag only: nothing regenerates on its own.
  IF p_doc_type = 'icp' THEN
    UPDATE strategy_documents
    SET is_stale = true
    WHERE organisation_id = p_org_id
      AND status          = 'active'
      AND is_stale        = false
      AND (
        (document_type = 'positioning' AND segment_id IS NULL)
        OR
        (document_type = 'messaging' AND segment_id IS NOT DISTINCT FROM p_segment_id)
      );

  ELSIF p_doc_type IN ('positioning', 'tov') THEN
    UPDATE strategy_documents
    SET is_stale = true
    WHERE organisation_id = p_org_id
      AND status          = 'active'
      AND is_stale        = false
      AND document_type   = 'messaging';
  END IF;

  RETURN to_jsonb(v_new_doc);
END;
$function$;

-- ─── approve_document_suggestion ────────────────────────────────────────────
--
-- Takes the rendered text from the caller and carries the suggestion's own recorded model
-- onto the promoted document.
--
-- THE MODEL COMES FROM THE SUGGESTION ROW, NOT FROM A PARAMETER. A suggestion can sit
-- pending for days, and auto-approval means it can be promoted long after it was generated.
-- Reading the model at approval time would record whichever model the code happens to name
-- then, which is a plausible-looking figure about the wrong run. The suggestion knows what
-- wrote it; the approval does not.

CREATE OR REPLACE FUNCTION public.approve_document_suggestion(
  p_suggestion_id uuid,
  p_reviewer_id   uuid,
  p_plain_text    text DEFAULT NULL::text
)
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

  SELECT promote_strategy_doc_version(
    v_suggestion.organisation_id,
    v_suggestion.document_type,
    v_suggestion.segment_id,
    v_content,
    'signal_suggestion',
    v_suggestion.revision_note,
    NULL,
    p_plain_text,
    v_suggestion.generated_by_model
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

-- ─── revert_strategy_doc_version ────────────────────────────────────────────
--
-- Needs NO new parameter and no caller change. It copies a previous version's content
-- forward unchanged, so the previous version's plain_text is by definition the correct
-- rendering of that content and is carried forward with it. Re-rendering would be work that
-- can only produce the same string, and asking the route to supply it would be asking the
-- caller for something the database already holds.
--
-- generated_by_model travels the same way and for a stronger reason: the restored content
-- was written by whatever model wrote the version being restored. Stamping the current model
-- would attribute old copy to a model that never saw it.

CREATE OR REPLACE FUNCTION public.revert_strategy_doc_version(p_document_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET row_security TO 'off'
AS $function$
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

  IF v_source.status = 'active' THEN
    RAISE EXCEPTION 'Document % is already the live version', p_document_id;
  END IF;

  SELECT promote_strategy_doc_version(
    v_source.organisation_id,
    v_source.document_type,
    v_source.segment_id,
    v_source.content,
    'revert',
    'Restored version ' || v_source.version || '.',
    'This version is the content of version ' || v_source.version || ', put back unchanged.',
    v_source.plain_text,
    v_source.generated_by_model
  ) INTO v_new;

  RETURN v_new;
END;
$function$;

-- ─── Privileges ─────────────────────────────────────────────────────────────
--
-- CREATE OR REPLACE on an existing signature preserves its ACL, but the two functions whose
-- signatures CHANGED are new objects as far as Postgres is concerned, and Supabase's
-- ALTER DEFAULT PRIVILEGES on the public schema grants EXECUTE to anon and authenticated at
-- creation time, BY NAME. REVOKE ... FROM PUBLIC would be a silent no-op against a grant
-- that was never held that way. So both roles are named explicitly.
--
-- These are SECURITY DEFINER and run with row_security off. An anon caller reaching
-- promote_strategy_doc_version could write a strategy document into any organisation.

REVOKE ALL ON FUNCTION public.promote_strategy_doc_version(uuid, text, uuid, jsonb, text, text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.promote_strategy_doc_version(uuid, text, uuid, jsonb, text, text, text, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.promote_strategy_doc_version(uuid, text, uuid, jsonb, text, text, text, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.approve_document_suggestion(uuid, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.approve_document_suggestion(uuid, uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_document_suggestion(uuid, uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.revert_strategy_doc_version(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.revert_strategy_doc_version(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revert_strategy_doc_version(uuid) TO service_role;

-- ─── Drop the superseded signatures ─────────────────────────────────────────
--
-- Adding defaulted parameters creates a NEW function rather than replacing the old one, so
-- both overloads now exist. Leaving the old ones is not merely untidy: a call passing the
-- original argument count still resolves to the OLD body, which does not write plain_text,
-- so the defect would survive its own fix in exactly the shape CLAUDE.md records for the
-- monitor sweep. Postgres would also reject an ambiguous call outright.
--
-- Dropped LAST so that a failure earlier in this migration leaves the working originals in
-- place rather than removing them ahead of their replacements.

DROP FUNCTION IF EXISTS public.promote_strategy_doc_version(uuid, text, uuid, jsonb, text, text, text);
DROP FUNCTION IF EXISTS public.approve_document_suggestion(uuid, uuid);
