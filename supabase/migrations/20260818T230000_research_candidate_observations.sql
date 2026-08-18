-- Candidate observation generation for the prospect research agent (FIX A).
--
-- Two changes:
--   1. Widen the signal_relevance CHECK on both tables. The selection rule now has
--      three outcomes instead of two: use_as_hook (passed all six tests),
--      mention_only (passed SPECIFIC + VERIFIABLE + RELEVANT only), no_signal
--      (nothing cleared the bar). 'ignore' is retained because it is the column
--      default on both tables and 29 existing rows carry it. Consumers treat
--      'ignore' and 'no_signal' identically.
--   2. Add prospect_research_results.candidates (jsonb) so every candidate the
--      agent considered is inspectable with its six-test scores and provenance,
--      not just the winner.
--
-- Status: APPLIED (verified live 2026-08-18)

ALTER TABLE public.prospects
  DROP CONSTRAINT IF EXISTS prospects_signal_relevance_check;

ALTER TABLE public.prospects
  ADD CONSTRAINT prospects_signal_relevance_check
  CHECK (signal_relevance = ANY (ARRAY['use_as_hook'::text, 'mention_only'::text, 'no_signal'::text, 'ignore'::text]));

ALTER TABLE public.prospect_research_results
  DROP CONSTRAINT IF EXISTS prospect_research_results_signal_relevance_check;

ALTER TABLE public.prospect_research_results
  ADD CONSTRAINT prospect_research_results_signal_relevance_check
  CHECK (signal_relevance = ANY (ARRAY['use_as_hook'::text, 'mention_only'::text, 'no_signal'::text, 'ignore'::text]));

-- Every candidate considered, with six-test scores and provenance.
-- Shape: [{ id, observation, source, provenance, date, is_composite,
--           scores: {specific, verifiable, inferential, relevant, useful, non_judgemental},
--           passes_all, score_total, rejection_reason }]
ALTER TABLE public.prospect_research_results
  ADD COLUMN IF NOT EXISTS candidates jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.prospect_research_results
  ADD COLUMN IF NOT EXISTS selected_candidate_id text;

COMMENT ON COLUMN public.prospect_research_results.candidates IS
  'All observation candidates generated during synthesis, each with six-test scores and provenance. Rejected candidates are retained deliberately so selection is auditable.';
