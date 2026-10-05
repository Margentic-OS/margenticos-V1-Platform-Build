-- Research arms: a 50/50 split of production research, with the shorter-reasoning arm held at
-- upload until the operator approves it for that batch.
--
-- Operator decisions, 2 Oct 2026 (Decisions Log: "DECIDED — Research cost"; Backlog: "BUILD:
-- move production research to the batch route"):
--   1. Each prospect is assigned an arm at random, 50/50, BEFORE research. Stored once, never
--      recomputed. Recorded on every research row and every spend line.
--   2. Arm 'short_reasoning' prospects are HELD AT UPLOAD until the operator approves the arm for
--      that batch.
--   4. The split must never delay a send. organisations.research_arm_split_enabled defaults OFF:
--      with it off, every prospect is 'standard' and nothing is held.
--
-- ADDITIVE ONLY. Nullable columns, plus one boolean with a default. No existing row or policy
-- changes. Table-level grants are unchanged, so the RLS and grant audits in CLAUDE.md read the
-- same before and after. Applied by MCP apply_migration, never by supabase db push.
--
-- The arm is written once, on prospects.research_arm, and COPIED (not recomputed) onto each
-- research row and spend line that a synthesis produced. research_usage.arm already exists and
-- carries the writer arms (firm_fact, writer_v2), so the spend line gets its own column.

-- The switch. Per organisation, off until the operator turns it on.
ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS research_arm_split_enabled boolean NOT NULL DEFAULT false;

-- The stored assignment, and the approval that releases a held short_reasoning prospect.
-- research_arm_released_at is NULL until the operator approves the batch the prospect's
-- research came from. The upload gate holds a short_reasoning prospect while it is NULL.
ALTER TABLE prospects
  ADD COLUMN IF NOT EXISTS research_arm text
    CHECK (research_arm IN ('standard', 'short_reasoning')),
  ADD COLUMN IF NOT EXISTS research_arm_released_at timestamptz;

-- The arm that produced this research row, and the Anthropic batch it was collected from
-- (NULL on an inline run, which has no batch). ON DELETE SET NULL, matching the other
-- references into synthesis_batches: the research row is the verdict and must survive a prune.
ALTER TABLE prospect_research_results
  ADD COLUMN IF NOT EXISTS research_arm text
    CHECK (research_arm IN ('standard', 'short_reasoning')),
  ADD COLUMN IF NOT EXISTS synthesis_batch_id uuid
    REFERENCES synthesis_batches(id) ON DELETE SET NULL;

-- The arm this spend line was billed under. Separate from the existing `arm` column, which
-- records the writer arm (firm_fact, writer_v2) and must not be overloaded.
ALTER TABLE research_usage
  ADD COLUMN IF NOT EXISTS research_arm text
    CHECK (research_arm IN ('standard', 'short_reasoning'));

-- Lookups the report and the approval both make: a batch's rows, and an arm's rows for an org.
CREATE INDEX IF NOT EXISTS prospect_research_results_batch_arm_idx
  ON prospect_research_results (synthesis_batch_id, research_arm)
  WHERE synthesis_batch_id IS NOT NULL;

-- Status: APPLIED (verified live 2026-10-05). Applied by MCP apply_migration to
-- hjpvnvjryxdjcfdsfhzy (production) and tidqheqjzvwmrrrebzir (test). Read back on both: all six
-- columns, their types and defaults, both CHECK constraints, the foreign key, the index, and
-- unchanged table grants. Filename timestamp 20261006100000; the version the database recorded
-- is its own, per CLAUDE.md.
