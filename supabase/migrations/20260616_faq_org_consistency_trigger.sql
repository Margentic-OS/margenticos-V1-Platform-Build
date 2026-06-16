-- 20260616_faq_org_consistency_trigger.sql
--
-- DATABASE-LEVEL WRITE ENFORCEMENT via trigger.
--
-- Problem: Service role bypasses RLS, so database RLS policies cannot protect service-role writes.
-- Solution: A trigger enforces org-consistency on writes REGARDLESS of role.
-- Triggers execute even when RLS is bypassed (service role), so they provide a real database-level guard.
--
-- What this trigger does:
-- On any INSERT or UPDATE to faq_extractions, validate that every referenced row
-- (signal_id, reply_draft_id, similar_faq_id, similar_pending_extraction_id)
-- belongs to the same organisation_id as the row being written.
--
-- Failure: Trigger raises an exception, and the write is rejected. CRITICAL: this is the
-- strongest possible guarantee that cross-org writes cannot silently occur, because
-- it is enforced at the data layer regardless of whether the caller has RLS or bypasses it.

BEGIN;

-- ── Trigger function for faq_extractions ────────────────────────────────────────

CREATE OR REPLACE FUNCTION validate_faq_extractions_org_consistency()
RETURNS TRIGGER AS $$
BEGIN
  -- Verify signal_id belongs to the same organisation
  IF NEW.signal_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM signals
      WHERE id = NEW.signal_id AND organisation_id = NEW.organisation_id
    ) THEN
      RAISE EXCEPTION
        'faq_extractions: CRITICAL — signal_id % does not belong to organisation %',
        NEW.signal_id, NEW.organisation_id;
    END IF;
  END IF;

  -- Verify reply_draft_id belongs to the same organisation
  IF NEW.reply_draft_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM reply_drafts
      WHERE id = NEW.reply_draft_id AND organisation_id = NEW.organisation_id
    ) THEN
      RAISE EXCEPTION
        'faq_extractions: CRITICAL — reply_draft_id % does not belong to organisation %',
        NEW.reply_draft_id, NEW.organisation_id;
    END IF;
  END IF;

  -- Verify similar_faq_id belongs to the same organisation
  IF NEW.similar_faq_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM faqs
      WHERE id = NEW.similar_faq_id AND organisation_id = NEW.organisation_id
    ) THEN
      RAISE EXCEPTION
        'faq_extractions: CRITICAL — similar_faq_id % does not belong to organisation %',
        NEW.similar_faq_id, NEW.organisation_id;
    END IF;
  END IF;

  -- Verify similar_pending_extraction_id belongs to the same organisation
  IF NEW.similar_pending_extraction_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM faq_extractions AS fe
      WHERE id = NEW.similar_pending_extraction_id AND organisation_id = NEW.organisation_id
    ) THEN
      RAISE EXCEPTION
        'faq_extractions: CRITICAL — similar_pending_extraction_id % does not belong to organisation %',
        NEW.similar_pending_extraction_id, NEW.organisation_id;
    END IF;
  END IF;

  -- All FK references belong to this organisation. Row is safe to write.
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── Attach trigger to faq_extractions ───────────────────────────────────────────

-- Drop existing trigger if it exists (idempotent)
DROP TRIGGER IF EXISTS faq_extractions_org_consistency_check ON faq_extractions;

-- Create new trigger
CREATE TRIGGER faq_extractions_org_consistency_check
BEFORE INSERT OR UPDATE ON faq_extractions
FOR EACH ROW
EXECUTE FUNCTION validate_faq_extractions_org_consistency();

COMMENT ON TRIGGER faq_extractions_org_consistency_check ON faq_extractions IS
  'Enforces organisation-level isolation at the data layer. Validates that every
   FK reference in the row belongs to the same organisation_id as the row itself.
   Runs on every INSERT/UPDATE regardless of user role, including service role.
   This is the primary defence against cross-organisation writes when RLS is bypassed.';

-- ── Trigger function for faqs ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION validate_faqs_org_exists()
RETURNS TRIGGER AS $$
BEGIN
  -- Verify organisation_id exists
  IF NOT EXISTS (
    SELECT 1 FROM organisations
    WHERE id = NEW.organisation_id
  ) THEN
    RAISE EXCEPTION
      'faqs: CRITICAL — organisation_id % does not exist',
      NEW.organisation_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── Attach trigger to faqs ──────────────────────────────────────────────────

DROP TRIGGER IF EXISTS faqs_org_consistency_check ON faqs;

CREATE TRIGGER faqs_org_consistency_check
BEFORE INSERT OR UPDATE ON faqs
FOR EACH ROW
EXECUTE FUNCTION validate_faqs_org_exists();

COMMENT ON TRIGGER faqs_org_consistency_check ON faqs IS
  'Enforces organisation-level isolation at the data layer for approved FAQ rows.
   Validates that the organisation_id actually exists in the organisations table.
   Faqs can be created via two paths: (1) manual operator creation via POST /api/operator/faqs,
   and (2) promotion of curated faq_extractions rows. Both paths now validate org-existence.
   Runs on every INSERT/UPDATE regardless of user role, including service role.';

COMMIT;
