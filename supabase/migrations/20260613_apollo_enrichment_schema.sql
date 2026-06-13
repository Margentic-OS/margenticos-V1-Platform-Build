-- Phase B: Apollo people enrichment schema
-- Adds enrichment columns to prospects, creates enrichment_runs table for audit trail.
-- Related: ADR-017 (tiered enrichment), sourcing pipeline (PRD-15).
--
-- A. prospects table: add email_status, enrichment_status, enrichment_run_id
--    enrichment_status tracks outcome: enriched, held_unverified, held_no_email, held_missing, held_duplicate
--    email_status stores Apollo's response value (verified, or whatever non-verified Apollo returns)
--    enrichment_run_id links to enrichment_runs for audit trail
--
-- B. Create enrichment_runs table to log each bulk_match operation
--    Records credits_consumed, batch size, outcomes per run, timestamp, status

BEGIN;

-- ── A. prospects: add enrichment tracking columns ──────────────────────────────
-- email_status: store Apollo's returned email_status (verified + others)
-- enrichment_status: track outcome (enriched, held_*, or NULL if not enriched yet)
-- enrichment_run_id: FK to enrichment_runs for audit

ALTER TABLE prospects
  ADD COLUMN email_status text NULL,
  ADD COLUMN enrichment_status text NULL
    CONSTRAINT prospects_enrichment_status_check
    CHECK (enrichment_status IN ('enriched', 'held_unverified', 'held_no_email', 'held_missing', 'held_duplicate')),
  ADD COLUMN enrichment_run_id uuid NULL;

-- ── B. enrichment_runs: audit table for bulk_match operations ───────────────
-- One row per enrichment batch run per organisation
-- Records: batch size, outcomes (requested/enriched/missing), credits consumed, status

CREATE TABLE enrichment_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id text NOT NULL,
  batch_size integer NOT NULL,
  total_requested_enrichments integer NOT NULL,
  unique_enriched_records integer NOT NULL,
  missing_records integer NOT NULL,
  credits_consumed integer NOT NULL,
  run_timestamp timestamptz NOT NULL,
  status text NOT NULL
    CONSTRAINT enrichment_runs_status_check
    CHECK (status IN ('success', 'partial', 'failed')),
  error_message text NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT enrichment_runs_organisation_fk
    FOREIGN KEY (organisation_id) REFERENCES organisations(id)
);

-- ── RLS: enrichment_runs (operator only) ──────────────────────────────────
ALTER TABLE enrichment_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY operator_enrichment_runs_all ON enrichment_runs
  USING (is_operator())
  WITH CHECK (is_operator());

-- ── RLS: enrichment columns on prospects (inherited from prospects table) ────
-- No separate RLS needed; inherited from prospects RLS

-- ── Index: enrichment_run_id for fast lookup ────────────────────────────────
CREATE INDEX idx_prospects_enrichment_run_id
  ON prospects(enrichment_run_id)
  WHERE enrichment_run_id IS NOT NULL;

-- ── Index: find prospects by enrichment_status ───────────────────────────────
CREATE INDEX idx_prospects_enrichment_status
  ON prospects(organisation_id, enrichment_status)
  WHERE enrichment_status IS NOT NULL;

COMMIT;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
-- ALTER TABLE prospects
--   DROP COLUMN IF EXISTS email_status,
--   DROP COLUMN IF EXISTS enrichment_status,
--   DROP COLUMN IF EXISTS enrichment_run_id;
-- DROP TABLE IF EXISTS enrichment_runs;
