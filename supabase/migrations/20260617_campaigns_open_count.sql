-- Migration: 20260617_campaigns_open_count.sql
--
-- Adds open_count to campaigns table to track email opens.
-- Populated by the Instantly analytics handler in campaign-analytics.ts,
-- which calls GET /api/v2/campaigns/analytics and extracts open_count field
-- from each campaign's response.
--
-- Open rate (opens / sent) is tracked for operator monitoring only.
-- Clients do NOT see open rates (Apple Mail Privacy Protection and image
-- preloading inflate opens, making them unreliable as a success metric).
--
-- Written by: service_role (cron handler)
-- Read by: operator-only views (via getAllCampaignMetricsForOrg)

BEGIN;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS open_count integer NOT NULL DEFAULT 0;

COMMIT;
