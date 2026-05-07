-- Fix three pre-existing RLS gaps where clients could not read their own data.
-- Surfaced during view-as-client diagnosis (session: 2026-05-07).
--
-- Pattern: all client SELECT policies use get_my_organisation_id() to scope to
-- the authenticated user's organisation. No role check in USING — the app layer
-- enforces client vs operator distinctions. Matches clients_read_own_campaigns
-- and other newer policies, not the older agent_runs inline-subquery style.
--
-- ADR-003: operators retain cross-org access via existing operators_full_access_*
-- policies on all three tables. Those policies are untouched by this migration.

BEGIN;

-- 1. strategy_documents
--    Existing policy covered status = 'active' only. Clients couldn't see
--    documents with status = 'approved' (e.g. freshly approved docs waiting
--    for status promotion). Extended to cover both statuses.
ALTER POLICY clients_read_own_active_strategy_docs
  ON strategy_documents
  USING (
    (organisation_id = get_my_organisation_id())
    AND (status = ANY (ARRAY['active'::text, 'approved'::text]))
  );

-- 2. document_suggestions
--    No client policy existed. Clients couldn't see pending suggestion
--    indicators on their own strategy documents in the dashboard.
CREATE POLICY clients_read_own_document_suggestions
  ON document_suggestions
  FOR SELECT
  TO authenticated
  USING (organisation_id = get_my_organisation_id());

-- 3. prospects
--    No client policy existed. Clients couldn't resolve prospect names
--    in the pipeline page meetings join (prospects joined via meetings query).
CREATE POLICY clients_read_own_prospects
  ON prospects
  FOR SELECT
  TO authenticated
  USING (organisation_id = get_my_organisation_id());

COMMIT;
