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
--
-- This migration is idempotent: wrapped in a DO block so it is a harmless no-op
-- if it runs before the function exists (e.g. alphabetical ordering on a fresh
-- deploy where this file (r) sorts before strategy_docs_revision.sql (s)).
-- The authoritative REVOKE now also lives inside strategy_docs_revision.sql
-- immediately after CREATE FUNCTION, eliminating any ordering gap.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'promote_strategy_doc_version'
  ) THEN
    REVOKE EXECUTE
      ON FUNCTION public.promote_strategy_doc_version(uuid, text, uuid, jsonb, text, text, text)
      FROM anon, authenticated;
  END IF;
END
$$;
