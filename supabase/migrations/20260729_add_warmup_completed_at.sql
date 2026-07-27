-- Migration: Add warmup_completed_at to organisations
-- Purpose: Mark when operator completes email warmup/placement-test phase
-- Used by: EMAIL 4 (WARMING_COMPLETE) trigger

BEGIN;

ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS warmup_completed_at timestamptz;

COMMIT;
