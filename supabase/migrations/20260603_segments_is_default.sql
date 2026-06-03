-- Part 0: is_default flag on segments.
-- Adds a boolean is_default column so every "which segment" fallback in application
-- code resolves deterministically to the org's primary segment without hardcoding the
-- 'default' slug. The partial unique index enforces exactly one primary per org at the
-- database level.
--
-- Part B: backfill prospects.segment_id.
-- All existing prospects belong to the org's primary segment. Stamp them now so the
-- research and compose paths have a non-null segment to work with immediately.
--
-- ── DOWN (reversal) ───────────────────────────────────────────────────────────
-- BEGIN;
-- UPDATE public.prospects SET segment_id = NULL;
-- DROP INDEX IF EXISTS public.segments_org_primary_idx;
-- UPDATE public.segments SET is_default = false;
-- ALTER TABLE public.segments DROP COLUMN IF EXISTS is_default;
-- COMMIT;
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. Add is_default column ──────────────────────────────────────────────────
ALTER TABLE public.segments
  ADD COLUMN is_default boolean NOT NULL DEFAULT false;

-- ── 2. Backfill: mark the sole default segment per org as primary ─────────────
-- The 'default' slug was stamped in the foundation migration and is the only
-- segment per org at this point — this UPDATE is 1-row-per-org.
UPDATE public.segments
SET is_default = true
WHERE slug = 'default';

-- ── 3. Partial unique index — exactly one primary per org ─────────────────────
-- A PARTIAL index on the true rows is the correct primitive: it enforces the
-- constraint without preventing multiple non-primary (is_default = false) segments.
CREATE UNIQUE INDEX segments_org_primary_idx
  ON public.segments(organisation_id)
  WHERE is_default = true;

-- ── 4. Backfill prospects — stamp each prospect with its org's primary segment ─
UPDATE public.prospects p
SET segment_id = s.id
FROM public.segments s
WHERE s.organisation_id = p.organisation_id
  AND s.is_default = true
  AND p.segment_id IS NULL;

COMMIT;
