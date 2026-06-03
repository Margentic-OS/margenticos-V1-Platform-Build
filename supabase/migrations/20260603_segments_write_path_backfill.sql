-- Segment-aware write path: Step B.
-- Adds segment_id to intake_responses and backfills segment_id on the three
-- tables whose write paths are being made segment-aware in this session.
--
-- Scope rules applied in backfill:
--   ICP and Messaging docs   → segment-scoped (set to org's default segment)
--   Positioning and TOV docs → org-level      (leave NULL)
--   intake_responses         → all rows       (set to org's default segment)
--   prospects                → NOT touched    (segment assignment is a later step)
--
-- ── DOWN (reversal) ───────────────────────────────────────────────────────────
-- BEGIN;
-- UPDATE public.document_suggestions SET segment_id = NULL
--   WHERE document_type IN ('icp', 'messaging');
-- UPDATE public.strategy_documents SET segment_id = NULL
--   WHERE document_type IN ('icp', 'messaging');
-- UPDATE public.intake_responses SET segment_id = NULL;
-- ALTER TABLE public.intake_responses DROP COLUMN IF EXISTS segment_id;
-- COMMIT;
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. Add segment_id to intake_responses ─────────────────────────────────────
ALTER TABLE public.intake_responses
  ADD COLUMN segment_id uuid
    REFERENCES public.segments(id) ON DELETE SET NULL;

-- ── 2. Backfill intake_responses ──────────────────────────────────────────────
-- Every existing intake row belongs to the org's default segment.
UPDATE public.intake_responses ir
SET segment_id = s.id
FROM public.segments s
WHERE s.organisation_id = ir.organisation_id
  AND s.slug = 'default';

-- ── 3. Backfill strategy_documents (icp + messaging only) ─────────────────────
UPDATE public.strategy_documents sd
SET segment_id = s.id
FROM public.segments s
WHERE s.organisation_id = sd.organisation_id
  AND s.slug = 'default'
  AND sd.document_type IN ('icp', 'messaging')
  AND sd.segment_id IS NULL;

-- ── 4. Backfill document_suggestions (icp + messaging only) ───────────────────
UPDATE public.document_suggestions ds
SET segment_id = s.id
FROM public.segments s
WHERE s.organisation_id = ds.organisation_id
  AND s.slug = 'default'
  AND ds.document_type IN ('icp', 'messaging')
  AND ds.segment_id IS NULL;

COMMIT;
