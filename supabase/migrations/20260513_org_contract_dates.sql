-- Migration: 20260513_org_contract_dates.sql
--
-- Adds contract_start_date and contract_end_date to the organisations table.
-- These are set by the operator at org creation time via the create-org form.
-- Both are nullable — no constraint forces them at DB level, matching the pattern
-- of other optional operator fields (payment_status, contract_status).
-- Type is date (not timestamptz) — these are calendar dates, not event timestamps.
--
-- ROLLBACK:
--   ALTER TABLE organisations DROP COLUMN IF EXISTS contract_start_date;
--   ALTER TABLE organisations DROP COLUMN IF EXISTS contract_end_date;

BEGIN;

ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS contract_start_date date,
  ADD COLUMN IF NOT EXISTS contract_end_date date;

COMMIT;
