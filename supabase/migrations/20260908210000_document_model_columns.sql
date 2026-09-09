-- Gives strategy_documents.plain_text a writer, and records which model wrote each document.
--
-- Status: APPLIED (verified live 2026-09-08)
--
-- ════════════════════════════════════════════════════════════════════════════
-- PART 1 — plain_text finally gets a writer
--
-- The column has existed since the table did and NOTHING has ever written it. It was NULL
-- on all 69 rows, measured 2026-09-08, so every consumer took its fallback branch: the four
-- generation agents and the buyer criterion agent read the prior version as
-- JSON.stringify(content), the client document views render a permanent and false
-- "Document content is being processed", and document_suggestions.current_value is written
-- from it, so it was NULL on all 91 suggestions.
--
-- The 69 existing rows were backfilled by scripts/backfill-plain-text.ts. This migration is
-- what stops the next INSERT re-creating the hole.
--
-- WHY THE TEXT IS PASSED IN RATHER THAN RENDERED HERE. The renderer is
-- src/lib/documents/render-plain-text.ts, in TypeScript, and it stays the only one. A
-- plpgsql renderer would be a SECOND renderer kept in step with the first by hand, which is
-- the parallel-list shape this project keeps getting bitten by: the monitor sweep's two
-- arrays, the incomplete literal behind an `as`, the fake that honoured .eq() and swallowed
-- .limit(). One renderer, called from the callers, is the whole point of the design.
--
-- p_plain_text DEFAULTS TO NULL DELIBERATELY, and that is a real trade-off worth naming. It
-- keeps every existing caller compiling and makes this migration safe to apply before the
-- code that passes the argument is deployed, which matters because migrations land ahead of
-- code on this project. The cost is that a future caller can forget the argument and
-- silently reintroduce exactly the defect this fixes. That risk is covered by a test that
-- asserts every promotion path passes it, not by hoping the next person remembers.
--
-- ════════════════════════════════════════════════════════════════════════════
-- PART 2 — which model wrote which document
--
-- Nothing recorded it. Measured 2026-09-08: no model column on strategy_documents,
-- document_suggestions or agent_runs, and across 795 agent_runs rows, ZERO mention any model
-- id or family in output_summary. So there is no way to say which model produced any of the
-- 69 live documents, and no way to attribute a change in copy quality after a regeneration.
--
-- This lands BEFORE the regeneration wave on purpose. The wave is the moment the record
-- becomes worth having, and a wave run without it loses the attribution permanently.
--
-- The model is NOT being changed in this migration or in the commit that carries it. See the
-- Decisions Log entry "Record the model before changing it, so copy quality is diagnosed with
-- one variable moved": copy quality has two candidate causes, the model and the fact that the
-- agent has never received prose, and changing both at once makes the comparison worthless.

-- ─── Part 2: the columns ────────────────────────────────────────────────────

ALTER TABLE public.strategy_documents
  ADD COLUMN IF NOT EXISTS generated_by_model text;

ALTER TABLE public.document_suggestions
  ADD COLUMN IF NOT EXISTS generated_by_model text;

COMMENT ON COLUMN public.strategy_documents.generated_by_model IS
  'The Anthropic model id that produced this document''s content, e.g. claude-opus-4-6. '
  'NULL on the 69 rows that predate 2026-09-08, and that NULL is honest: it is not '
  'recoverable, because nothing recorded it. Never inferred from a date.';

COMMENT ON COLUMN public.document_suggestions.generated_by_model IS
  'The Anthropic model id that produced suggested_value. Carried onto strategy_documents '
  'when the suggestion is approved, so a promoted document keeps the model that wrote it '
  'rather than the model current at approval time.';
