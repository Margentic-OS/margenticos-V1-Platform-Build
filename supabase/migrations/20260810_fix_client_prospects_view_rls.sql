-- Migration: Fix RLS and grants on client_prospects_view
-- Purpose: Restrict view access to authenticated users only and set SECURITY_INVOKER
-- to ensure RLS policies are enforced on underlying prospects table
-- Date: 2026-08-10
-- Status: APPLIED (verified live 2026-08-10 post-deploy)
-- Applied via: Supabase MCP apply_migration (external, not Vercel deploy)

BEGIN;

-- ── 1. Revoke all public access to the view ────────────────────────────────
REVOKE ALL ON client_prospects_view FROM public;
REVOKE ALL ON client_prospects_view FROM anon;

-- ── 2. Set SECURITY_INVOKER = true so RLS applies to underlying prospects ──
-- This ensures that the view's queries respect the prospect table's RLS policies
CREATE OR REPLACE VIEW client_prospects_view
WITH (SECURITY_INVOKER = true) AS
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
  tier_published_at,
  created_at,
  suppressed
FROM prospects
WHERE organisation_id = get_my_organisation_id();

-- ── 3. Grant only to authenticated role (not anon, not public) ──────────────
GRANT SELECT ON client_prospects_view TO authenticated;

COMMIT;
