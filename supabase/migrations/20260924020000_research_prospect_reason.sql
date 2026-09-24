-- Status: APPLIED (verified live 2026-09-24, both projects: hjpvnvjryxdjcfdsfhzy and tidqheqjzvwmrrrebzir)
-- The reason THIS prospect has, and the second event that supports it.
--
-- A trigger now carries a principle saying why that KIND of event creates a need. That
-- principle is about the event and is the same for every prospect it matches. What reaches
-- the email has to be the principle APPLIED to what was actually found, and that is this
-- column: one sentence, under 15 words, reading grade 6 or below, grounded in the fact.
--
-- WHY IT IS STORED RATHER THAN RE-DERIVED. The writer's second line states it, the closing
-- question asks about the consequence it names, and the follow-up writer argues from it, so
-- all four emails argue one thing. Re-deriving it per email would let the four drift apart,
-- which is the fault this whole change exists to stop.
--
-- NULL HAS TWO MEANINGS and both are legitimate: synthesis reached no winner, or the model's
-- sentence failed the same shape rules a trigger reason is held to and was dropped rather
-- than corrected. Dropping falls back to relevance_reason, which is what the writer read
-- before this existed.
ALTER TABLE public.prospect_research_results
  ADD COLUMN IF NOT EXISTS prospect_reason text,
  ADD COLUMN IF NOT EXISTS supporting_candidate_id text;
