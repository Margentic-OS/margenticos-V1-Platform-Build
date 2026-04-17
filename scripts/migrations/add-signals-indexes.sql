-- scripts/migrations/add-signals-indexes.sql
-- Add indexes to the signals table to support efficient pattern aggregation queries.
-- Applied while the table is empty — index creation at zero rows costs nothing.
-- At scale (100k+ rows) creating indexes without CONCURRENTLY locks the table.
--
-- Applied via Supabase MCP migration: add_signals_indexes

-- Supports queries that filter by organisation and signal type
-- (e.g. "all email_reply signals for org X")
CREATE INDEX IF NOT EXISTS idx_signals_org_type
  ON public.signals (organisation_id, signal_type);

-- Supports queries that filter by organisation and processing time
-- (e.g. "signals for org X processed in the last 30 days")
CREATE INDEX IF NOT EXISTS idx_signals_org_processed_at
  ON public.signals (organisation_id, processed_at);

-- Supports cross-organisation pattern queries by type and time
-- Used by the pattern aggregation agent
CREATE INDEX IF NOT EXISTS idx_signals_type_processed_at
  ON public.signals (signal_type, processed_at);

-- Supports the pattern agent's unprocessed signal query
-- (e.g. "all signals where processed = false")
CREATE INDEX IF NOT EXISTS idx_signals_processed
  ON public.signals (processed);
