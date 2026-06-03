-- Adds client-approval lifecycle to strategy_documents.
--
-- New active docs default to client_approval_status='pending'. The client
-- approves, an operator force-approves, or the doc auto-approves after 3 days.
-- Existing active docs are grandfathered to 'approved' so live orgs are not
-- retroactively gated.
--
-- approve_document_suggestion is updated to explicitly set the two new columns
-- in its INSERT (matching its existing explicit-column style per build rules).
-- SECURITY DEFINER + owner preserved; EXECUTE from public re-revoked.
--
-- ── DOWN ──────────────────────────────────────────────────────────────────────
-- (restore prior function version, then drop columns)
-- ALTER TABLE public.strategy_documents
--   DROP COLUMN IF EXISTS client_approval_status,
--   DROP COLUMN IF EXISTS approval_source,
--   DROP COLUMN IF EXISTS approved_at,
--   DROP COLUMN IF EXISTS pending_since;

BEGIN;

-- ── 1. Add client-approval columns ───────────────────────────────────────────
ALTER TABLE public.strategy_documents
  ADD COLUMN client_approval_status text NOT NULL DEFAULT 'pending'
    CONSTRAINT strategy_docs_client_approval_status_check
    CHECK (client_approval_status IN ('pending', 'approved')),
  ADD COLUMN approval_source text NULL
    CONSTRAINT strategy_docs_approval_source_check
    CHECK (approval_source IN ('client', 'auto', 'operator')),
  ADD COLUMN approved_at timestamptz NULL,
  ADD COLUMN pending_since timestamptz NOT NULL DEFAULT now();

-- ── 2. Backfill existing active docs as operator-approved ─────────────────────
-- These predate the client-approval feature; marking them pending would
-- retroactively gate orgs that are already running.
UPDATE public.strategy_documents
SET
  client_approval_status = 'approved',
  approval_source        = 'operator',
  approved_at            = now()
WHERE status = 'active';

-- ── 3. Update approve_document_suggestion — add explicit approval columns ──────
-- The function's INSERT uses an explicit column list and sets status='active'
-- explicitly, so the two new columns must also be listed explicitly here.
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

  UPDATE strategy_documents
  SET status = 'archived', last_updated_at = now()
  WHERE organisation_id = v_suggestion.organisation_id
    AND document_type   = v_suggestion.document_type
    AND status          = 'active';

  -- New docs start pending client approval.
  INSERT INTO strategy_documents (
    organisation_id,
    document_type,
    version,
    content,
    status,
    generated_at,
    last_updated_at,
    update_trigger,
    client_approval_status,
    pending_since
  )
  VALUES (
    v_suggestion.organisation_id,
    v_suggestion.document_type,
    v_new_version::text,
    v_content,
    'active',
    now(),
    now(),
    'signal_suggestion',
    'pending',
    now()
  )
  RETURNING * INTO v_new_doc;

  UPDATE document_suggestions
  SET
    status      = 'approved',
    reviewed_at = now(),
    reviewed_by = p_reviewer_id
  WHERE id = p_suggestion_id;

  RETURN to_jsonb(v_new_doc);
END;
$function$;

-- ── 4. Re-revoke EXECUTE from public (belt-and-suspenders) ───────────────────
REVOKE EXECUTE ON FUNCTION public.approve_document_suggestion(uuid, uuid) FROM PUBLIC;

COMMIT;
