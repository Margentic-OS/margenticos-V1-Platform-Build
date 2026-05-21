-- Audit fix (2026-05-21): REVOKE EXECUTE FROM PUBLIC on five SECURITY DEFINER functions.
--
-- Root cause: prior migrations used REVOKE FROM anon/authenticated, which does not remove
-- a PUBLIC-based grant. In Postgres, revoking from specific roles leaves the PUBLIC grant
-- intact, so anon/authenticated still inherited execute access via PUBLIC.
-- Correct fix: REVOKE FROM PUBLIC.
--
-- Functions covered:
--   approve_document_suggestion — SECURITY DEFINER with SET row_security = 'off'; highest risk
--   append_faq_variant          — SECURITY DEFINER; could corrupt FAQ variant data
--   handle_new_auth_user        — auth trigger; must not be callable via REST API
--   handle_new_user             — auth trigger; must not be callable via REST API
--   rls_auto_enable             — DDL trigger; must not be callable via REST API

REVOKE EXECUTE ON FUNCTION public.approve_document_suggestion(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.append_faq_variant(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.handle_new_auth_user() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC;
