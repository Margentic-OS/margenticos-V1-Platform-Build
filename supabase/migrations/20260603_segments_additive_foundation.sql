-- Multi-segment foundation: additive schema changes only.
-- Adds the segments table, nullable segment_id FK columns on three existing
-- tables, RLS policies for segments, and one default segment per org.
--
-- Zero behaviour change: segment_id is NULL on all existing rows and no query
-- anywhere references it yet. The unique constraint on
-- (organisation_id, segment_id, document_type) is intentionally absent here —
-- deferred to the final migration step when all strategy_document queries have
-- been updated to filter by segment_id.
--
-- ── DOWN (reversal) ───────────────────────────────────────────────────────────
-- BEGIN;
-- ALTER TABLE public.prospects             DROP COLUMN IF EXISTS segment_id;
-- ALTER TABLE public.document_suggestions  DROP COLUMN IF EXISTS segment_id;
-- ALTER TABLE public.strategy_documents    DROP COLUMN IF EXISTS segment_id;
-- DELETE FROM public.segments WHERE slug = 'default';
-- DROP TABLE IF EXISTS public.segments CASCADE;
-- COMMIT;
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. segments table ─────────────────────────────────────────────────────────

CREATE TABLE public.segments (
  id               uuid        NOT NULL DEFAULT gen_random_uuid(),
  organisation_id  uuid        NOT NULL
    REFERENCES public.organisations(id) ON DELETE CASCADE,
  name             text        NOT NULL,
  slug             text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT segments_pkey         PRIMARY KEY (id),
  CONSTRAINT segments_org_slug_key UNIQUE (organisation_id, slug)
);

CREATE INDEX segments_organisation_id_idx ON public.segments (organisation_id);

ALTER TABLE public.segments ENABLE ROW LEVEL SECURITY;

-- ── 2. RLS policies ───────────────────────────────────────────────────────────
-- Pattern: clients_read_own_* (SELECT, USING org = get_my_organisation_id())
--          operators_full_access_* (ALL, USING + WITH CHECK is_operator())
-- Source pattern from 20260507_pre_c1_client_rls_gaps.sql and
-- 20260512_faq_rls_operator_policies.sql.

CREATE POLICY clients_read_own_segments
  ON public.segments
  FOR SELECT
  TO authenticated
  USING (organisation_id = get_my_organisation_id());

CREATE POLICY operators_full_access_segments
  ON public.segments
  FOR ALL
  TO authenticated
  USING (is_operator())
  WITH CHECK (is_operator());

-- ── 3. Nullable segment_id FKs on existing tables ────────────────────────────
-- ON DELETE SET NULL: if a segment is deleted, related rows become NULL-scoped
-- (org-level fallback) rather than being deleted. All existing rows remain NULL.

ALTER TABLE public.strategy_documents
  ADD COLUMN segment_id uuid
    REFERENCES public.segments(id) ON DELETE SET NULL;

ALTER TABLE public.document_suggestions
  ADD COLUMN segment_id uuid
    REFERENCES public.segments(id) ON DELETE SET NULL;

ALTER TABLE public.prospects
  ADD COLUMN segment_id uuid
    REFERENCES public.segments(id) ON DELETE SET NULL;

-- ── 4. Default segment per existing organisation ──────────────────────────────
-- Creates the anchor row each org's future segments will join.
-- segment_id is NOT backfilled onto any existing strategy_documents,
-- document_suggestions, or prospects rows — that backfill is coupled with
-- each table's query-update step and lands in a later migration.

INSERT INTO public.segments (organisation_id, name, slug)
SELECT id, 'Default', 'default'
FROM public.organisations
ON CONFLICT (organisation_id, slug) DO NOTHING;

COMMIT;
