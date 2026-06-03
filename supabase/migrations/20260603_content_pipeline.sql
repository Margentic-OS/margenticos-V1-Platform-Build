-- Content pipeline: bridge-input backfill + campaign sequence shell tracking
--
-- Part 1 — Backfill has_dateable_signal
-- Prospects that were imported before the research agent ran have NULL here.
-- Set false: honest default (no dateable signal found). The bridge path in
-- compose-sequence stays off until research actually runs and sets a real value.
-- Re-researching existing prospects is not in scope for this migration.
UPDATE prospects SET has_dateable_signal = false WHERE has_dateable_signal IS NULL;

-- Part 2 — Campaign sequence shell tracking columns
-- Records the Messaging doc version and structure (step count + delays) that a
-- campaign's Instantly sequence shell was built from.
--
-- shell_synced_at   : when the shell was last pushed to the outbound provider
-- shell_doc_id      : strategy_documents.id the shell was built from
-- shell_step_count  : number of email steps in the shell (must match active Messaging doc at upload)
-- shell_delays      : [{delay: number, delay_unit: 'days'|'hours'}, ...] — one entry per step
-- shell_segment_id  : which segment's Messaging doc was used (null = default segment)
--
-- At upload time: if shell_step_count IS NULL → block ("sync sequence shell first")
--                 if shell_step_count != active doc step count → block ("shell out of sync")
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS shell_synced_at timestamptz;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS shell_doc_id uuid;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS shell_step_count integer;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS shell_delays jsonb;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS shell_segment_id uuid;
