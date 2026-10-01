-- Status: NOT YET APPLIED
--
-- ADR-061 step 4: a new ICP version keeps the client's place in the search.
--
-- ═══ WHAT THIS CHANGES ═══════════════════════════════════════════════════════
--
-- promote_strategy_doc_version, for ICPs, moves the sourcing cursor's key from the row
-- being replaced to the new row, and leaves record_offset alone. Everything else in the
-- function is unchanged from 20260930231500.
--
-- Before this, every new ICP version was a new document id, the cursor was keyed on the
-- old one, and readCursor reset the position to zero. Measured 2026-09-28: the first run
-- after such a reset read 200 records and 134 of them were people already held.
--
-- ═══ WHY IT IS SAFE NOW AND WAS NOT SAFE IN STEP 3 ═══════════════════════════
--
-- Keeping the offset is only correct when the query has not changed. Step 3 made a new
-- version INHERIT the settings, but the old code still re-derived them afterwards and
-- could change the search, so an inherited offset could have pointed into a different
-- result set. Records would have been skipped, silently.
--
-- Step 4 removes that re-derivation: after a promotion the settings on the new row are
-- the ones on the old row, byte for byte, until an operator approves a proposal. The
-- approval decides the cursor for itself (step 5: reset when the built query differs).
--
-- ═══ ROLLOUT ORDER, WHICH IS PART OF THE CHANGE ══════════════════════════════
--
-- APPLY THIS ONLY AFTER THE STEP 4 CODE IS SERVING IN PRODUCTION. A migration is live
-- the moment it is applied. Applied before the code, it would meet the old re-derivation
-- and recreate the hazard above. Applied after, the worst case in the gap is a promotion
-- that resets the cursor, which is what happened on every promotion before today.
--
-- The grants are restated and read back in both directions, as in 20260930231500.

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
  -- The row being replaced. NULL for a client's first ICP and for every other document type.
  v_old_id      uuid;
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
    SELECT id, icp_filter_spec, icp_filter_spec_proposed,
           icp_filter_spec_approved_at, icp_filter_spec_approved_by
      INTO v_old_id, v_spec, v_proposed, v_approved_at, v_approved_by
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

  -- ADR-061: the sourcing cursor follows the settings onto the new row.
  --
  -- The new row carries the SAME settings as the row it replaces, so it builds the SAME
  -- provider query, and the client's place in that result set is still valid. Only the
  -- document id the cursor is keyed on has changed, so the key is moved and the offset is
  -- left exactly where it was. record_offset is deliberately not assigned here.
  --
  -- ONLY when the cursor points at the row being replaced. A cursor keyed to some older
  -- version is one this function knows nothing about, and it is left for readCursor to
  -- reset, which re-reads from the top: wasteful, and never wrong.
  IF p_doc_type = 'icp' AND v_old_id IS NOT NULL THEN
    UPDATE sourcing_cursors
       SET icp_document_id = v_new_doc.id,
           updated_at      = now()
     WHERE organisation_id = p_org_id
       AND icp_document_id = v_old_id;
  END IF;

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

REVOKE ALL ON FUNCTION public.promote_strategy_doc_version(uuid, text, uuid, jsonb, text, text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.promote_strategy_doc_version(uuid, text, uuid, jsonb, text, text, text, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.promote_strategy_doc_version(uuid, text, uuid, jsonb, text, text, text, text, text) TO service_role;
