-- Status: NOT YET APPLIED
--
-- ADR-061 step 3: an approval state beside the stored search settings, and a new ICP version
-- that INHERITS the live settings.
--
-- ═══ WHAT THIS CHANGES ═══════════════════════════════════════════════════════
--
-- 1. Three columns on strategy_documents, beside icp_filter_spec:
--
--      icp_filter_spec_proposed     a proposed set of search settings, waiting for the
--                                   operator. NULL means nothing is pending.
--      icp_filter_spec_approved_at  when the LIVE settings were approved.
--      icp_filter_spec_approved_by  the operator who approved them.
--
--    Nothing writes any of them yet. Steps 4 and 5 do.
--
-- 2. promote_strategy_doc_version, for ICPs, copies the outgoing active row's settings, its
--    pending proposal and its approval stamp onto the new row, in the same statement that
--    creates it.
--
-- ═══ WHY THE COPY IS UNCONDITIONAL ════════════════════════════════════════════
--
-- The function does not ask whether the edit touched targeting. It cannot: that question is
-- answered by one TypeScript function (targetingInputs), and a second copy of the answer in
-- SQL is two lists that have to be kept in step by hand. So every new ICP version starts
-- with exactly the settings the previous one had, and anything that should change them is a
-- separate, later step that a person approves.
--
-- ═══ WHAT IS DELIBERATELY NOT HERE: THE SOURCING CURSOR ═══════════════════════
--
-- The plan put the cursor re-key in this migration. ADR-061 moved it to step 4, and the
-- reason is the order things reach production. A migration is live the moment it is
-- applied; the code that goes with it is live only when it deploys.
--
-- Until step 4 deploys, the old path still re-derives the settings after every promotion
-- and may change the search. If this function kept the cursor's offset across that, the
-- offset would point into a different result set and records would be skipped, silently.
-- Today a new document id resets the cursor, which wastes a re-read and loses nothing.
-- That is the safe direction, so it stays until the re-derivation is gone.
--
-- ═══ WHAT THE CURRENTLY DEPLOYED CODE DOES AGAINST THIS ══════════════════════
--
-- Checked before applying, because the database moves first.
--
--   The three columns are new and nullable. Deployed code names none of them.
--   After a promotion, deployed code still re-derives and OVERWRITES icp_filter_spec on
--   the new row, so the end state is what it is today.
--   Two things do change, both in the direction ADR-061 wants:
--     - a new ICP row is no longer live with NULL settings while the derivation runs.
--       It carries the previous settings for those seconds, so sourcing and tiering no
--       longer throw in that window and the buyer gate no longer fails open.
--     - when the derivation FAILS, the row keeps the previous settings and sourcing
--       continues on them, where before it kept NULL and sourcing refused.
--
-- ═══ ACCESS ═══════════════════════════════════════════════════════════════════
--
-- The columns inherit the table's row level security. A client can already read their own
-- organisation's icp_filter_spec through that policy, and can read these three the same
-- way. No client screen selects them.
--
-- The function is SECURITY DEFINER and bypasses RLS, so its grants are restated here and
-- read back in both directions after applying. CREATE OR REPLACE keeps existing grants;
-- they are restated anyway so this file is the whole truth about who can call it.

ALTER TABLE public.strategy_documents
  ADD COLUMN IF NOT EXISTS icp_filter_spec_proposed    jsonb,
  ADD COLUMN IF NOT EXISTS icp_filter_spec_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS icp_filter_spec_approved_by uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'strategy_documents_icp_filter_spec_approved_by_fkey'
       AND conrelid = 'public.strategy_documents'::regclass
  ) THEN
    -- SET NULL, not CASCADE and not RESTRICT: removing an operator's account must neither
    -- delete a client's document nor be blocked by one.
    ALTER TABLE public.strategy_documents
      ADD CONSTRAINT strategy_documents_icp_filter_spec_approved_by_fkey
      FOREIGN KEY (icp_filter_spec_approved_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

COMMENT ON COLUMN public.strategy_documents.icp_filter_spec_proposed IS
  'ADR-061. A proposed set of search settings waiting for the operator''s approval. NULL means nothing is pending. Never read by sourcing, tiering or the buyer gate: those read icp_filter_spec only.';
COMMENT ON COLUMN public.strategy_documents.icp_filter_spec_approved_at IS
  'ADR-061. When the live search settings in icp_filter_spec were approved. Copied forward to each new ICP version with the settings.';
COMMENT ON COLUMN public.strategy_documents.icp_filter_spec_approved_by IS
  'ADR-061. The operator who approved the live search settings.';

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
  -- ADR-061: the settings a new ICP version inherits. All four stay NULL for every other
  -- document type, and for a client's first ICP.
  v_spec        jsonb;
  v_proposed    jsonb;
  v_approved_at timestamptz;
  v_approved_by uuid;
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

  -- Read BEFORE the insert, from the row that is about to be archived. Unconditional: this
  -- function does not know which fields are targeting, and must not come to.
  IF p_doc_type = 'icp' THEN
    SELECT icp_filter_spec, icp_filter_spec_proposed,
           icp_filter_spec_approved_at, icp_filter_spec_approved_by
      INTO v_spec, v_proposed, v_approved_at, v_approved_by
    FROM strategy_documents
    WHERE organisation_id = p_org_id
      AND document_type   = 'icp'
      AND segment_id IS NOT DISTINCT FROM p_segment_id
      AND status          = 'active'
    ORDER BY created_at DESC
    LIMIT 1;
  END IF;

  INSERT INTO strategy_documents (
    organisation_id, segment_id, document_type, version, content, status,
    generated_at, last_updated_at, update_trigger, revision_note, change_summary,
    plain_text, generated_by_model,
    icp_filter_spec, icp_filter_spec_proposed,
    icp_filter_spec_approved_at, icp_filter_spec_approved_by
  )
  VALUES (
    p_org_id, p_segment_id, p_doc_type, v_new_version::text, p_content, 'active',
    now(), now(), p_update_trigger, p_revision_note, p_change_summary,
    p_plain_text, p_generated_by_model,
    v_spec, v_proposed,
    v_approved_at, v_approved_by
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

-- Supabase's default privileges grant EXECUTE to anon and authenticated BY NAME on every
-- function created in public, so revoking from PUBLIC alone is a silent no-op. Named here.
REVOKE ALL ON FUNCTION public.promote_strategy_doc_version(uuid, text, uuid, jsonb, text, text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.promote_strategy_doc_version(uuid, text, uuid, jsonb, text, text, text, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.promote_strategy_doc_version(uuid, text, uuid, jsonb, text, text, text, text, text) TO service_role;

-- Read back after applying, in BOTH directions. Expect t, f, f.
--
--   SELECT has_function_privilege('service_role',  p.oid, 'EXECUTE'),
--          has_function_privilege('authenticated', p.oid, 'EXECUTE'),
--          has_function_privilege('anon',          p.oid, 'EXECUTE')
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'promote_strategy_doc_version';
