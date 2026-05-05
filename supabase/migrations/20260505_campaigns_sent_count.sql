-- Migration: 20260505_campaigns_sent_count.sql
--
-- Adds campaign send/reply/bounce aggregates to the campaigns table.
-- These columns are populated by the Instantly analytics handler in
-- src/lib/integrations/handlers/instantly/campaign-analytics.ts, which
-- calls GET /api/v2/campaigns/analytics and writes the results on each
-- cron run via src/app/api/cron/instantly-poll/route.ts.
--
-- Written by: service_role (cron handler). Read by: authenticated users
-- via RLS policies already on the campaigns table. No new RLS policies
-- are needed — row visibility is governed by the existing campaigns table
-- policies; these columns are additive to existing rows.

BEGIN;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS sent_count    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS replied_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bounced_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS campaign_stats_updated_at timestamptz;

COMMIT;
