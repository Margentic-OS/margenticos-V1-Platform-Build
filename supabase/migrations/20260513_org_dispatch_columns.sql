-- Migration: 20260513_org_dispatch_columns.sql
--
-- Adds two idempotency-anchor columns to organisations:
--
-- agents_dispatched_at (timestamptz, nullable, default null)
--   Set atomically by /api/intake/complete on the first dispatch of the four
--   strategy agents (ICP, TOV, Positioning, Messaging). Used as a guard to
--   prevent double-dispatch if the client POSTs the route more than once.
--   Pattern: UPDATE ... WHERE id = $org AND agents_dispatched_at IS NULL RETURNING id
--   Zero rows returned = already dispatched, return early.
--
-- docs_complete_notification_sent_at (timestamptz, nullable, default null)
--   Set atomically by whichever strategy agent finishes last. Prevents two agents
--   completing simultaneously from both sending the "all docs generated" email.
--   Pattern: UPDATE ... WHERE id = $org AND docs_complete_notification_sent_at IS NULL
--             AND <all four agent_runs exist> RETURNING id
--   If row returned, this agent claimed the right to send. If not, another agent
--   already sent it.
--
-- ROLLBACK:
--   ALTER TABLE organisations DROP COLUMN IF EXISTS agents_dispatched_at;
--   ALTER TABLE organisations DROP COLUMN IF EXISTS docs_complete_notification_sent_at;

BEGIN;

ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS agents_dispatched_at timestamptz,
  ADD COLUMN IF NOT EXISTS docs_complete_notification_sent_at timestamptz;

COMMIT;
