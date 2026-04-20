-- Session 5, Part 1 — Task 2
-- Add variant_id to prospects table.
-- Tracks which messaging variant (A/B/C/D) a prospect has been assigned.
-- Null = not yet assigned. See ADR-014: sequence composition.

ALTER TABLE prospects
  ADD COLUMN IF NOT EXISTS variant_id text DEFAULT NULL;
