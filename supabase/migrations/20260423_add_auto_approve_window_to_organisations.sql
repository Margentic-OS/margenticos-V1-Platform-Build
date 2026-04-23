-- Add per-client auto-approve window to organisations.
-- Default 72 hours matches CLAUDE.md spec for cold email and LinkedIn DM.
-- LinkedIn posts default to 24h — a per-channel override is a Phase 2 concern.
-- Operator can adjust per client via direct table update or a future settings UI.

ALTER TABLE organisations
  ADD COLUMN auto_approve_window_hours integer NOT NULL DEFAULT 72;
