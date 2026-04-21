-- Add personalisation research fields to prospects table.
-- Used by the prospect research agent (TBV framework).
-- trigger_data stores the full TBV JSON object for the composition handler and operator review.
ALTER TABLE prospects
  ADD COLUMN IF NOT EXISTS trigger_confidence text,
  ADD COLUMN IF NOT EXISTS research_ran_at timestamptz,
  ADD COLUMN IF NOT EXISTS trigger_data jsonb;
