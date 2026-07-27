-- Migration: Client prospect review schema
-- Purpose: Add client-facing tier sanction + sample rejection surface
--          with lazy-write auto-approval after 4 days
-- Date: 2026-07-28

BEGIN;

-- ── 1. Add client review columns to prospects ────────────────────────────────
ALTER TABLE prospects
ADD COLUMN IF NOT EXISTS client_review_status text NULL
  CHECK (client_review_status IN ('pending_review', 'approved', 'rejected')),
ADD COLUMN IF NOT EXISTS client_review_reason text NULL
  CHECK (char_length(client_review_reason) <= 200),
ADD COLUMN IF NOT EXISTS client_review_auto_approved_at timestamptz NULL;

-- ── 2. Create client-safe view ───────────────────────────────────────────────
-- Exposes only columns safe for client review.
-- SECURITY INVOKER = false so view runs as postgres (can read full table).
-- WHERE clause enforces row-level isolation.

CREATE OR REPLACE VIEW client_prospects_view
WITH (SECURITY_INVOKER = false) AS
SELECT
  id,
  organisation_id,
  first_name,
  last_name,
  company_name,
  role,
  job_title,
  linkedin_url,
  website_url,
  company_industry,
  company_headcount,
  personalisation_trigger,
  client_review_status,
  client_review_reason,
  client_review_auto_approved_at,
  sourced_tier,
  created_at,
  suppressed
FROM prospects
WHERE organisation_id = get_my_organisation_id();

GRANT SELECT ON client_prospects_view TO authenticated;

-- ── 3. Add indexes for query performance ─────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_prospects_client_review_status
  ON prospects(organisation_id, client_review_status)
  WHERE client_review_status IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_prospects_sourced_tier_client_review
  ON prospects(organisation_id, sourced_tier, client_review_status)
  WHERE sourced_tier IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_prospects_org_tier_suppressed
  ON prospects(organisation_id, sourced_tier, suppressed)
  WHERE sourced_tier IS NOT NULL;

-- ── 4. Update RLS: deny direct table access, force view usage ────────────────
-- Drop the permissive clients_read_own_prospects policy.
-- Clients must use the view, which restricts columns at read time.

DROP POLICY IF EXISTS clients_read_own_prospects ON prospects;

CREATE POLICY clients_read_own_prospects_denied
  ON prospects
  FOR SELECT
  TO authenticated
  USING (false); -- Deny all direct SELECT; clients must use view

-- ── 5. Add policy for client updates ─────────────────────────────────────────
-- Clients can UPDATE their org's prospects (column restrictions enforced in app).

CREATE POLICY clients_update_own_prospect_review
  ON prospects
  FOR UPDATE
  TO authenticated
  USING (organisation_id = get_my_organisation_id())
  WITH CHECK (organisation_id = get_my_organisation_id());

-- ── 6. Operator policies (explicit, to replace implicit defaults) ────────────
-- Operators retain full access. Explicitly grant for clarity.

CREATE POLICY operators_full_access_prospects
  ON prospects
  FOR ALL
  TO authenticated
  USING (is_operator())
  WITH CHECK (is_operator());

COMMIT;
