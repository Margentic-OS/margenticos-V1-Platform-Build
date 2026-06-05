-- Grant EXECUTE on approve_document_suggestion to service_role.
--
-- Root cause of approve-button bug (2026-06-05):
--   20260521134057_revoke_public_execute_security_fix.sql revoked EXECUTE FROM PUBLIC
--   on this function, which was correct security hygiene. But no explicit GRANT TO
--   service_role was ever added alongside it. The approve route calls this function
--   via the service_role key, so every click on Approve in the UI failed with
--   "permission denied for function approve_document_suggestion" at the Postgres layer.
--   The route caught the rpcError and returned: "Approval failed. The suggestion has
--   not been changed. Check server logs."
--
-- Why service_role only, not authenticated:
--   The function is SECURITY DEFINER with SET row_security TO 'off'. Granting to
--   authenticated would allow any logged-in user (including clients) to call it directly
--   via the Supabase client, bypassing the route's operator check. The route owns the
--   auth gate; the function should only be reachable through it.

GRANT EXECUTE ON FUNCTION public.approve_document_suggestion(uuid, uuid) TO service_role;
