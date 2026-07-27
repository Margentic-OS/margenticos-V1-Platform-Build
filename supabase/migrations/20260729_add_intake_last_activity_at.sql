-- Migration: Add intake_last_activity_at to organisations
-- Purpose: Track when client last answered intake questions
-- Used by: EMAIL 1 (INTAKE_NUDGE) trigger and cron

BEGIN;

ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS intake_last_activity_at timestamptz;

-- Index for fast queries on intake progress check
CREATE INDEX IF NOT EXISTS idx_organisations_intake_last_activity
  ON organisations(intake_last_activity_at)
  WHERE intake_last_activity_at IS NOT NULL;

COMMIT;
