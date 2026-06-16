-- 20260616_client_reply_view_rls.sql
-- Adds RLS policy for client reply view (org-scoping backstop).
--
-- This migration enables authenticated clients to read reply_handling_actions
-- scoped to their own organisation_id. Clients see only their org's replies.
--
-- The intent filter (which intents are visible) is NOT enforced by RLS.
-- Intent filtering is enforced ONLY by the application query via the
-- getClientVisibleReplies() chokepoint function. See ADR (to be created):
-- "Client reply view: dual-filter model (org = RLS-backed, intent = chokepoint-enforced)".
--
-- SECURITY NOTE (ADR discipline):
-- This RLS policy is the database backstop for org-scoping only.
-- If a client query ever bypasses the chokepoint and queries reply_handling_actions directly,
-- the RLS policy prevents cross-org leaks.
-- But the intent filter (positive intents only) is not protected by RLS — it is enforced
-- ONLY by the chokepoint function. Org-scoping has defence-in-depth (RLS + query);
-- intent-filtering has only application enforcement.

BEGIN;

-- Add the clients_read_own_replies policy to reply_handling_actions.
-- Clients can read only rows where organisation_id matches their own.
CREATE POLICY "clients_read_own_replies"
  ON reply_handling_actions
  FOR SELECT
  TO authenticated
  USING (
    organisation_id = (
      SELECT organisation_id
      FROM users
      WHERE id = auth.uid()
    )
  );

COMMIT;
