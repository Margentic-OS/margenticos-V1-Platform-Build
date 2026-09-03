-- When an upstream document changes, mark the downstream ones stale. Flag only.
--
-- Status: APPLIED (verified live 2026-09-03)
--
-- ─── WHY FLAG AND NOT REGENERATE ──────────────────────────────────────────────
--
-- Judging whether an upstream change is relevant to a downstream document is exactly
-- what an automatic rewrite cannot do. A client's voice must not change mid-campaign
-- because a headcount band moved. So this marks, and an operator decides.
--
-- ─── WHAT WAS ACTUALLY THERE BEFORE, WHICH IS NOT WHAT THE NAME SUGGESTS ──────
--
-- triggerCascadeIfEligible has always been called a cascade and has never propagated a
-- change. isEligible() returns true only when the downstream type has NO active document
-- and NO pending suggestion, so once positioning exists an ICP change can never reach it.
-- It is a first-generation sequencer: it gets a new client from one document to four and
-- then does nothing for ever. It is left exactly as it is, because that job is still
-- worth doing.
--
-- strategy_documents.is_stale has existed since the table was created, defaults false,
-- and nothing in the codebase has ever read or written it. Every row in production was
-- false. This is its first use.
--
-- ─── WHY THE MARKING LIVES IN THIS FUNCTION ───────────────────────────────────
--
-- promote_strategy_doc_version is the single chokepoint every new version passes
-- through: the suggestion approval path, the auto-approve cron, the client revision
-- path and revert all reach it. Marking here cannot be forgotten by a fifth caller.
--
-- The dependency graph is ALSO expressed in src/lib/agents/cascade/document-dependencies.ts.
-- Two copies that must agree is the parallel-array shape from CLAUDE.md, so
-- src/lib/agents/cascade/__tests__/document-dependencies.test.ts reads this file and
-- fails if the two disagree. That test scans a migration and therefore proves what this
-- migration said, not what the database does now. It is an early warning, not the
-- authority.
--
-- ─── SEGMENT SCOPING ──────────────────────────────────────────────────────────
--
-- ICP and messaging are segment-scoped. Positioning and the voice guide are org-level and
-- always carry segment_id NULL. So an ICP change staleness-marks messaging IN ITS OWN
-- SEGMENT only, and positioning at org level. A positioning or voice-guide change marks
-- messaging in EVERY segment, because one org-level document feeds all of them.
--
-- ─── HOW A DOCUMENT STOPS BEING STALE ─────────────────────────────────────────
--
-- By being regenerated. is_stale defaults false, so the new version inserted below is
-- never born stale, and the row carrying the flag is archived in the same call. There is
-- deliberately no "dismiss" control: dismissing would leave a document that an operator
-- has decided is fine with no record that they decided it, which is indistinguishable
-- from one nobody looked at.
--
-- ─── DOWN ─────────────────────────────────────────────────────────────────────
-- Restore the definition in 20260903100000_promote_without_client_approval.sql.

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

  -- Archive the version it replaces. Excludes the row just inserted, which is the
  -- only reason the ordering is safe.
  UPDATE strategy_documents
  SET status = 'archived', last_updated_at = now()
  WHERE organisation_id = p_org_id
    AND document_type   = p_doc_type
    AND segment_id IS NOT DISTINCT FROM p_segment_id
    AND status          = 'active'
    AND id             <> v_new_doc.id;

  -- Mark the downstream documents stale. DOWNSTREAM_OF: icp -> positioning, messaging;
  -- positioning -> messaging; tov -> messaging; messaging -> nothing.
  --
  -- last_updated_at is deliberately NOT touched. The document page reports when a
  -- document last changed, and going stale is a fact about a DIFFERENT document.
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
    -- Org-level upstream, so every segment's messaging is affected.
    UPDATE strategy_documents
    SET is_stale = true
    WHERE organisation_id = p_org_id
      AND status          = 'active'
      AND is_stale        = false
      AND document_type   = 'messaging';
  END IF;

  RETURN to_jsonb(v_new_doc);
END;
$$;

REVOKE ALL ON FUNCTION public.promote_strategy_doc_version(uuid, text, uuid, jsonb, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.promote_strategy_doc_version(uuid, text, uuid, jsonb, text, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.promote_strategy_doc_version(uuid, text, uuid, jsonb, text, text, text) TO service_role;

COMMIT;
