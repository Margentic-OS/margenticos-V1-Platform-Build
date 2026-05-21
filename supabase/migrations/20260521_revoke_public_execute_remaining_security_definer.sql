-- Remove PUBLIC and anon execute access on get_my_organisation_id() and is_operator().
--
-- Both functions have explicit per-role grants in addition to the PUBLIC grant:
--   {=X/postgres, anon=X/postgres, authenticated=X/postgres, service_role=X/postgres}
--
-- REVOKE FROM PUBLIC removes the blanket grant.
-- REVOKE FROM anon removes the explicit anon grant.
-- authenticated and service_role retain their explicit grants — RLS policies are unaffected.

REVOKE EXECUTE ON FUNCTION public.get_my_organisation_id() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_my_organisation_id() FROM anon;

REVOKE EXECUTE ON FUNCTION public.is_operator() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_operator() FROM anon;
