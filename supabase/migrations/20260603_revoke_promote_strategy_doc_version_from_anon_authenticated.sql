-- promote_strategy_doc_version was created as a NEW function in
-- 20260603_strategy_docs_revision.sql. Supabase automatically issues explicit
-- EXECUTE grants to anon, authenticated, and service_role for every newly
-- created function; REVOKE FROM PUBLIC in that migration did not remove those
-- individual grants.
--
-- approve_document_suggestion was safe because it was replaced via
-- CREATE OR REPLACE on an existing function — no auto-grant fired.
--
-- Without this fix, any logged-in user could call
-- supabase.rpc('promote_strategy_doc_version', { p_org_id: 'victim-org', ... })
-- directly, bypassing the route-level ownership check in /api/documents/revise
-- and archiving/replacing documents in any organisation.
--
-- The /api/documents/revise route already calls the function via a service-role
-- client and verifies org ownership before the RPC call. This migration ensures
-- the function is unreachable except through that gated path.

REVOKE EXECUTE
  ON FUNCTION public.promote_strategy_doc_version(uuid, text, uuid, jsonb, text, text, text)
  FROM anon, authenticated;
