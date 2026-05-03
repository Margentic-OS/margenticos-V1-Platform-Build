-- 20260503_faq_extractions_extension.sql
-- Extends faq_extractions with four columns returned by faq-extraction-agent.ts
-- that were absent from the original Phase 2 migration.
--
-- Pre-condition: faq_extractions was empty when this ran (verified 0 rows before apply).
-- Applied via Supabase MCP on 2026-05-03 before Group 5 build.

BEGIN;

ALTER TABLE faq_extractions
  ADD COLUMN similar_pending_extraction_id uuid REFERENCES faq_extractions(id),
  ADD COLUMN similarity_score              numeric(4,3),
  ADD COLUMN potential_names_flagged       jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN prompt_version               text;

COMMENT ON COLUMN faq_extractions.similar_pending_extraction_id IS
  'Self-referential FK to another faq_extractions row when the extracted
   question is similar to a pending (not-yet-approved) extraction. Allows
   the curation UI (Group 7) to dedupe pending candidates rather than
   creating duplicate FAQ entries.';
COMMENT ON COLUMN faq_extractions.similarity_score IS
  'Top similarity score (0.000-1.000) from the FAQ matcher when
   similar_faq_id or similar_pending_extraction_id is populated. Null
   when no match above the 0.45 threshold was found.';
COMMENT ON COLUMN faq_extractions.potential_names_flagged IS
  'Array of capitalised tokens detected in captured_answer that may be
   personal names. Surfaced in curation UI for operator review before
   the candidate becomes a canonical FAQ. Defaults to empty array.';
COMMENT ON COLUMN faq_extractions.prompt_version IS
  'Version of docs/prompts/faq-extraction-agent.md that produced this
   extraction. For traceability when prompt evolves.';

COMMIT;
