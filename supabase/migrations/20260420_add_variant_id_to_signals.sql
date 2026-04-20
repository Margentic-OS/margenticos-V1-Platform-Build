-- Session 5, Part 2 — Task 4
-- Add variant_id to signals table for per-variant performance tracking.
-- See ADR-014: variant performance is tracked via the existing signals infrastructure.
-- Populated from prospects.variant_id when a signal is written with a known prospect_id.
-- Webhook handlers (Part 3) will populate this field at write time.

ALTER TABLE signals
  ADD COLUMN IF NOT EXISTS variant_id text DEFAULT NULL;
