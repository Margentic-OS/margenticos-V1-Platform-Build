-- Migration: 20260506_organisations_target_and_setup_status.sql
--
-- Adds two operator-configurable columns to the organisations table.
--
-- monthly_meetings_target (integer, NOT NULL, DEFAULT 8)
--   Per-client monthly meeting target used by MomentumBlock in the pipeline view.
--   Previously hardcoded to 8 in the component. Storing it here lets the operator
--   set a different target per client without a code change.
--   Written by: operator (direct DB update until operator UI is built).
--   Read by: authenticated users via the pipeline page query.
--   RLS: no new policies needed — additive column inherits existing organisations RLS.
--
-- setup_status (jsonb, NOT NULL, DEFAULT '{"campaigns":"pending","linkedin":"pending"}')
--   Per-client setup progress for the two configurable setup steps shown in the
--   DocumentsActiveState view (the empty-state view shown while warmup is in progress).
--   The "Strategy documents" card is always complete in documents_active state and is
--   not stored here — only the two operator-managed steps are tracked.
--   Valid status values per key: "pending" | "in_progress" | "complete"
--   Written by: operator (direct DB update until operator UI is built).
--   Read by: authenticated users via the dashboard page query.
--   RLS: no new policies needed — additive column inherits existing organisations RLS.
--
-- ROLLBACK:
--   ALTER TABLE organisations DROP COLUMN IF EXISTS monthly_meetings_target;
--   ALTER TABLE organisations DROP COLUMN IF EXISTS setup_status;

BEGIN;

ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS monthly_meetings_target integer NOT NULL DEFAULT 8;

ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS setup_status jsonb NOT NULL DEFAULT '{"campaigns":"pending","linkedin":"pending"}';

COMMIT;
