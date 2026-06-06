-- Unique partial index on document_suggestions: at most one pending suggestion
-- per (organisation_id, document_type) at a time. Prevents duplicate pending
-- rows when cascade dispatches an agent that is already running.
--
-- The window between cascade dispatch and the agent writing its pending row
-- (typically 60-180s) means a second cascade could fire before the first row
-- lands. This index is the backstop. Each agent's INSERT catches 23505 as an
-- idempotent no-op.

CREATE UNIQUE INDEX IF NOT EXISTS document_suggestions_org_type_pending_unique
  ON document_suggestions (organisation_id, document_type)
  WHERE status = 'pending';
