-- Adds two columns to organisations:
--   warmup_started_at: operator sets this when email warmup actually begins.
--     NULL = warmup not started; all warmup UI hides until operator sets a date.
--   linkedin_channel_enabled: operator toggle, default false.
--     When false, all client-facing LinkedIn surfaces are hidden.

ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS warmup_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS linkedin_channel_enabled boolean NOT NULL DEFAULT false;
