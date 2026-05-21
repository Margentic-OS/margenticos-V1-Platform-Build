-- Prompt 3A, Commit 1
-- Adds outbound tracking columns to prospects, display name to campaigns,
-- external_id index + unique partial index to campaigns, cross-org integrity
-- trigger, and P0 security fixes (REVOKE EXECUTE on two SECURITY DEFINER functions).
--
-- ATOMICITY: wrapped in BEGIN / COMMIT. All DDL is transactional in Postgres 17.
--
-- Naming note: outbound_ prefix on new prospects columns (not instantly_) per
-- ADR-001 tool-agnostic compliance. If Instantly is replaced by another cold-email
-- platform, these column names remain valid without renaming.

BEGIN;

-- ── 1. prospects: outbound tracking columns ────────────────────────────────

ALTER TABLE public.prospects
  ADD COLUMN outbound_lead_id         text,
  ADD COLUMN outbound_upload_status   text NOT NULL DEFAULT 'pending'
    CONSTRAINT prospects_outbound_upload_status_check
      CHECK (outbound_upload_status IN ('pending', 'uploading', 'uploaded', 'failed')),
  ADD COLUMN outbound_upload_attempted_at  timestamptz,
  ADD COLUMN outbound_upload_error         text,
  ADD COLUMN campaign_id                   uuid
    REFERENCES public.campaigns(id) ON DELETE SET NULL;

-- The outbound_upload_status CHECK constraint value set is closed.
-- Adding a new status (e.g. 'queued', 'partial') requires a new migration
-- to expand the constraint. This mirrors the same lesson learned from
-- signals_signal_type_check (see supabase/migrations/20260502_signals_signal_type_constraint.sql).
-- Do not add status values in application code without a matching migration.

-- ── 2. campaigns: display name column ─────────────────────────────────────
-- A human-readable label for the campaign, set by the operator at registration.
-- Distinct from sequence_name (Instantly's internal sequence identifier).

ALTER TABLE public.campaigns
  ADD COLUMN name text;

-- ── 3. campaigns: btree index on external_id ──────────────────────────────
-- The polling code queries .eq('external_id', ...) on every reply poll cycle.
-- Without this index, that is a sequential scan. Confirmed absent from all
-- migration files and live DB index list before this migration.

CREATE INDEX campaigns_external_id_idx
  ON public.campaigns (external_id);

-- ── 4. campaigns: unique partial index on external_id ─────────────────────
-- Prevents the same Instantly campaign UUID from being registered to two
-- different organisations. Partial (WHERE external_id IS NOT NULL) so that
-- campaigns with no external_id (e.g. future non-Instantly campaigns) can
-- coexist without constraint violation.

CREATE UNIQUE INDEX campaigns_external_id_unique_idx
  ON public.campaigns (external_id)
  WHERE external_id IS NOT NULL;

-- ── 5. Cross-org integrity: prospects.campaign_id must belong to same org ─
-- CHECK constraints cannot query other tables in Postgres, so this is
-- implemented as a BEFORE INSERT OR UPDATE trigger.
-- Raises an exception (SQLSTATE 23503, foreign_key_violation) if a prospect
-- is assigned to a campaign that belongs to a different organisation.

CREATE OR REPLACE FUNCTION public.check_prospect_campaign_org_match()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.campaign_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.campaigns
      WHERE id = NEW.campaign_id
        AND organisation_id = NEW.organisation_id
    ) THEN
      RAISE EXCEPTION
        'prospect campaign_id % does not belong to organisation_id %',
        NEW.campaign_id,
        NEW.organisation_id
        USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER prospects_campaign_org_check
  BEFORE INSERT OR UPDATE OF campaign_id, organisation_id
  ON public.prospects
  FOR EACH ROW
  EXECUTE FUNCTION public.check_prospect_campaign_org_match();

-- ── 6. P0 security fixes ──────────────────────────────────────────────────
-- Source: docs/discovery/2026-05-13-rls-verification.md, P0-1 and P0-2.
-- Both functions are SECURITY DEFINER and callable by anon via REST API.
-- approve_document_suggestion has SET row_security TO 'off' and no auth check —
-- a genuine vulnerability. append_faq_variant can corrupt FAQ variant data.
-- These must not be callable via /rest/v1/rpc/<function_name> by unauthenticated
-- or authenticated non-operator callers. Approval is operator-only, invoked via
-- server actions with independent role checks.

REVOKE EXECUTE ON FUNCTION public.approve_document_suggestion(uuid, uuid)
  FROM anon;
REVOKE EXECUTE ON FUNCTION public.approve_document_suggestion(uuid, uuid)
  FROM authenticated;

REVOKE EXECUTE ON FUNCTION public.append_faq_variant(uuid, text)
  FROM anon;
REVOKE EXECUTE ON FUNCTION public.append_faq_variant(uuid, text)
  FROM authenticated;

COMMIT;
