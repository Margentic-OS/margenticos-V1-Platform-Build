-- Prompt 3A, Commit 2
-- P1 security hygiene fixes.
-- Source: docs/discovery/2026-05-13-rls-verification.md, P1-1 and P1-2.
--
-- ATOMICITY: wrapped in BEGIN / COMMIT.

BEGIN;

-- ── P1-1: integration_credentials explicit RLS policies ───────────────────
-- Table has RLS enabled but zero policies. Supabase defaults to DENY ALL for
-- non-service-role connections when no policies exist — currently safe because
-- all application reads use SUPABASE_SERVICE_ROLE_KEY (bypasses RLS). Adding
-- explicit policies documents intent and prevents silent breakage if a future
-- code path accidentally uses a client session to read credentials.
--
-- Design: authenticated clients are explicitly blocked (belt-and-suspenders).
-- Operators can read all credentials for future connection-status UI.
-- All writes from application code use service_role; no INSERT/UPDATE policy
-- for authenticated sessions is intentional.

CREATE POLICY clients_cannot_access_credentials
  ON public.integration_credentials
  FOR ALL
  TO authenticated
  USING (false);

CREATE POLICY operators_read_credentials
  ON public.integration_credentials
  FOR SELECT
  TO authenticated
  USING (is_operator());

CREATE POLICY operators_manage_credentials
  ON public.integration_credentials
  FOR ALL
  TO authenticated
  USING (is_operator())
  WITH CHECK (is_operator());

-- ── P1-2: REVOKE trigger/admin functions from REST API ────────────────────
-- handle_new_auth_user(), handle_new_user(), and rls_auto_enable() are
-- SECURITY DEFINER functions used internally (triggers, admin tooling).
-- They should never be directly callable via /rest/v1/rpc/<function_name>.
-- No exploit path was identified, but the exposure is inappropriate.
-- Source: docs/discovery/2026-05-13-rls-verification.md, P1-2.

REVOKE EXECUTE ON FUNCTION public.handle_new_auth_user() FROM anon;
REVOKE EXECUTE ON FUNCTION public.handle_new_auth_user() FROM authenticated;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM authenticated;

REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM anon;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM authenticated;

COMMIT;
