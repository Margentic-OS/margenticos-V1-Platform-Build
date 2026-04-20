-- Session 5, Part 2 — Additional fix
-- Add founder_first_name to organisations.
-- Used as the sign-off name in generated email sequences (per ADR-014).
-- Required field during client onboarding — populate via Settings → Organisation.

ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS founder_first_name text DEFAULT NULL;
