-- Status: APPLIED (verified live 2026-10-01, both production hjpvnvjryxdjcfdsfhzy and test
--         tidqheqjzvwmrrrebzir). Applied before the step 5 code merged, which is safe:
--         nothing called either function until that code deployed.
--         Read back on BOTH:
--           - each function body stored in the database has the same md5 and the same
--             length as the body in this file (approve 3,992, reject 1,175), so what was
--             applied is what is committed
--           - EXECUTE on each: service_role true, authenticated false, anon false
--           - one overload each, SECURITY INVOKER, search_path=public
--           - control: promote_strategy_doc_version read back in the same query as
--             SECURITY DEFINER with its known md5, so the query can tell the two apart
--         Production only:
--           - zero of 17 SECURITY DEFINER functions in public are executable by anon
--           - a probe on a real client's active ICP, in a DO block ending in RAISE
--             EXCEPTION so nothing could commit. Planted a proposal, then: reject naming
--             another proposal REFUSED; approve naming another proposal REFUSED; approve
--             with other live settings REFUSED; approve with both switches on APPLIED
--             (settings became the proposal, proposal cleared, stamp written, offset
--             500 -> 0, 62 removed prospects re-queued, 541 survivors untouched); approve
--             again REFUSED with no_proposal; a second planted proposal rejected, leaving
--             the settings as they were. Read back afterwards: nothing pending, no probe
--             text, the approval stamp unchanged, the cursor at 500, 62 still removed
--         Test only:
--           - the live test, 35 passed against the real functions: each switch on and
--             off, the re-queue's scope, another organisation never touched, every
--             refusal leaving every row as it was, and a failed stamp rolling back the
--             cursor reset and the re-queue with it
--
-- ADR-061 step 5: the two functions that end a proposal's life.
--
-- ═══ WHAT THIS ADDS ══════════════════════════════════════════════════════════
--
--   approve_icp_filter_spec_proposal   makes a pending proposal the live search settings
--   reject_icp_filter_spec_proposal    clears a pending proposal and changes nothing else
--
-- Nothing calls either until the step 5 code is deployed, so applying this before the
-- code is safe: a function with no caller changes no behaviour.
--
-- ═══ WHY AN APPROVAL IS ONE FUNCTION AND NOT FOUR STATEMENTS FROM THE APP ════
--
-- An approval does up to four things: replace the settings, stamp who and when, reset the
-- client's place in the search, and put the removed prospects back in the tiering queue.
-- Sent from the application one at a time, any of them can fail after the one before it
-- has committed, and every half-applied state is silent:
--
--   settings replaced, cursor not reset     the offset points into a different result
--                                           set. Records are skipped, never re-read, and
--                                           nothing reports it.
--   settings replaced, prospects not        the people the old rule removed keep the old
--   re-queued                               verdict. Nothing else re-queues them, and the
--                                           proposal is gone, so the approval cannot be
--                                           retried.
--
-- Inside one function they commit together or not at all.
--
-- ═══ WHAT THE FUNCTION CHECKS, AND WHAT IT LEAVES TO THE CALLER ══════════════
--
-- THE FLOORS ARE NOT HERE. Whether the proposed buyer criterion gates, and whether every
-- removed exclusion was ticked, are judged in application code by the same functions the
-- pre-enrichment gate and the before-and-after panel use
-- (src/lib/sourcing/approve-icp-filter-spec.ts). A second copy of those rules in SQL
-- would agree with the first until one of them changed.
--
-- What IS here is the thing only the database can promise: that the row being written is
-- still the row those judgements were made about. The caller passes the proposal AND the
-- live settings it read. The function locks the row and refuses unless both still match.
-- So a proposal re-filed, or settings replaced, between the caller's read and this write
-- cannot be approved on the strength of a judgement about something else.
--
-- p_reset_cursor and p_requeue are the caller's decisions (ADR-061 rules 7 and 8), made
-- from the same two values this function verifies.
--
-- ═══ A SOURCING RUN IN FLIGHT ════════════════════════════════════════════════
--
-- A sourcing run reads the cursor when it starts and writes `start + records read` when
-- it finishes. An approval that resets the cursor while a run is in flight would be
-- overwritten by that run's final write: an offset counted against the OLD search, stored
-- against the NEW one. So an approval that resets the cursor is refused while a run for
-- that organisation is marked running and started within the last 15 minutes.
--
-- 15 minutes because the sourcing route's own budget is 300 seconds and the longest
-- completed run on record is 172 (production, read 2026-10-01). A run that crashed
-- without closing its record stays 'running' for ever, and must not block approvals for
-- ever.
--
-- NOT CLOSED: a run that starts in the few milliseconds between this check and this
-- transaction's commit. Closing it means the sourcing run taking a lock, which is a change
-- to the sourcing path and is not made here.
--
-- ═══ SECURITY ════════════════════════════════════════════════════════════════
--
-- SECURITY INVOKER, deliberately, unlike promote_strategy_doc_version. The only caller is
-- the operator route through the service role, which already holds every privilege these
-- statements need. Running as the caller means that if a grant below were ever widened by
-- mistake, the caller's own RLS would still stand between it and the rows.
--
-- The grants are still revoked BY NAME, because Supabase's default privileges grant
-- EXECUTE to anon and authenticated explicitly and REVOKE FROM PUBLIC alone removes
-- nothing. Read back in both directions when applied.

CREATE OR REPLACE FUNCTION public.approve_icp_filter_spec_proposal(
  p_document_id       uuid,
  p_expected_proposal jsonb,
  p_expected_live     jsonb,
  p_approved_by       uuid,
  p_reset_cursor      boolean,
  p_requeue           boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
DECLARE
  v_doc             record;
  v_previous_offset integer;
  v_cursor_reset    boolean := false;
  v_requeued        integer := 0;
BEGIN
  IF p_expected_proposal IS NULL OR p_approved_by IS NULL
     OR p_reset_cursor IS NULL OR p_requeue IS NULL THEN
    RAISE EXCEPTION 'approve_icp_filter_spec_proposal: the proposal, the approver and both decisions are required';
  END IF;

  SELECT id, organisation_id, document_type, status,
         icp_filter_spec, icp_filter_spec_proposed
    INTO v_doc
    FROM strategy_documents
   WHERE id = p_document_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'refused', 'not_found');
  END IF;
  IF v_doc.document_type <> 'icp' THEN
    RETURN jsonb_build_object('applied', false, 'refused', 'not_icp');
  END IF;
  IF v_doc.status <> 'active' THEN
    RETURN jsonb_build_object('applied', false, 'refused', 'not_active');
  END IF;
  IF v_doc.icp_filter_spec_proposed IS NULL THEN
    RETURN jsonb_build_object('applied', false, 'refused', 'no_proposal');
  END IF;
  -- jsonb equality is structural: key order and whitespace do not matter, values do.
  IF v_doc.icp_filter_spec_proposed <> p_expected_proposal THEN
    RETURN jsonb_build_object('applied', false, 'refused', 'changed_since_shown');
  END IF;
  IF v_doc.icp_filter_spec IS DISTINCT FROM p_expected_live THEN
    RETURN jsonb_build_object('applied', false, 'refused', 'changed_since_shown');
  END IF;

  IF p_reset_cursor AND EXISTS (
    SELECT 1
      FROM sourcing_runs
     WHERE organisation_id = v_doc.organisation_id
       AND status          = 'running'
       AND started_at      > now() - interval '15 minutes'
  ) THEN
    RETURN jsonb_build_object('applied', false, 'refused', 'sourcing_in_progress');
  END IF;

  UPDATE strategy_documents
     SET icp_filter_spec             = v_doc.icp_filter_spec_proposed,
         icp_filter_spec_proposed    = NULL,
         icp_filter_spec_approved_at = now(),
         icp_filter_spec_approved_by = p_approved_by
   WHERE id = p_document_id;

  -- ADR-061 rule 8. The offset indexes into ONE result set. When the caller found that the
  -- provider request built from the new settings differs from the old, the old offset means
  -- nothing, and the client reads the new result set from the top.
  --
  -- The key is moved onto this document as well, so a cursor left on an older version ends
  -- up where readCursor would have put it anyway.
  IF p_reset_cursor THEN
    SELECT record_offset
      INTO v_previous_offset
      FROM sourcing_cursors
     WHERE organisation_id = v_doc.organisation_id
       FOR UPDATE;

    IF FOUND THEN
      UPDATE sourcing_cursors
         SET record_offset   = 0,
             icp_document_id = p_document_id,
             updated_at      = now()
       WHERE organisation_id = v_doc.organisation_id;
      v_cursor_reset := true;
    END IF;
  END IF;

  -- ADR-061 rule 7, which replaces ADR-037's trigger and keeps its rule. A removal is a
  -- frozen verdict, and exactly one thing thaws it: the approval of a change to something
  -- tiering reads. The scope is ADR-037's, unchanged: this organisation only, only rows
  -- with no tier, only rows that were actually classified. A survivor keeps its tier.
  --
  -- Clearing the reason also returns a row the pre-enrichment buyer gate rejected to
  -- enrichment eligibility, because that gate records its verdict in the same column.
  IF p_requeue THEN
    WITH requeued AS (
      UPDATE prospects
         SET tiering_reason = NULL
       WHERE organisation_id = v_doc.organisation_id
         AND sourced_tier IS NULL
         AND tiering_reason IS NOT NULL
      RETURNING id
    )
    SELECT count(*)::integer INTO v_requeued FROM requeued;
  END IF;

  RETURN jsonb_build_object(
    'applied',         true,
    'organisation_id', v_doc.organisation_id,
    'cursor_reset',    v_cursor_reset,
    'previous_offset', v_previous_offset,
    'requeued_count',  v_requeued
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.approve_icp_filter_spec_proposal(uuid, jsonb, jsonb, uuid, boolean, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.approve_icp_filter_spec_proposal(uuid, jsonb, jsonb, uuid, boolean, boolean) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_icp_filter_spec_proposal(uuid, jsonb, jsonb, uuid, boolean, boolean) TO service_role;

-- Reject: the proposal is cleared and NOTHING else is written. The live settings, the
-- approval stamp, the cursor and every prospect are untouched.
--
-- It names the proposal for the same reason approve does. Rejecting "whatever is pending"
-- would let an operator who was shown one proposal throw away a different one that was
-- filed while they were reading.
CREATE OR REPLACE FUNCTION public.reject_icp_filter_spec_proposal(
  p_document_id       uuid,
  p_expected_proposal jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
DECLARE
  v_doc record;
BEGIN
  IF p_expected_proposal IS NULL THEN
    RAISE EXCEPTION 'reject_icp_filter_spec_proposal: the proposal being rejected is required';
  END IF;

  SELECT id, organisation_id, document_type, status, icp_filter_spec_proposed
    INTO v_doc
    FROM strategy_documents
   WHERE id = p_document_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('rejected', false, 'refused', 'not_found');
  END IF;
  IF v_doc.document_type <> 'icp' THEN
    RETURN jsonb_build_object('rejected', false, 'refused', 'not_icp');
  END IF;
  IF v_doc.status <> 'active' THEN
    RETURN jsonb_build_object('rejected', false, 'refused', 'not_active');
  END IF;
  IF v_doc.icp_filter_spec_proposed IS NULL THEN
    RETURN jsonb_build_object('rejected', false, 'refused', 'no_proposal');
  END IF;
  IF v_doc.icp_filter_spec_proposed <> p_expected_proposal THEN
    RETURN jsonb_build_object('rejected', false, 'refused', 'changed_since_shown');
  END IF;

  UPDATE strategy_documents
     SET icp_filter_spec_proposed = NULL
   WHERE id = p_document_id;

  RETURN jsonb_build_object('rejected', true, 'organisation_id', v_doc.organisation_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.reject_icp_filter_spec_proposal(uuid, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reject_icp_filter_spec_proposal(uuid, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reject_icp_filter_spec_proposal(uuid, jsonb) TO service_role;
