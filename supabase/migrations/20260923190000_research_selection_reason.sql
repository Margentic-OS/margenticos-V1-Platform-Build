-- Status: APPLIED (verified live 2026-09-23, both projects: hjpvnvjryxdjcfdsfhzy and tidqheqjzvwmrrrebzir)
-- Why the chosen observation won, recorded beside the choice.
--
-- The trigger list decides WHAT COUNTS as relevant for a client. It does not decide which
-- instance to use, and until now nothing recorded that second decision: the row carried
-- selected_candidate_id and the reader had to re-derive, from the candidate scores, why that
-- one rather than the three beside it. On a reading file that is the question actually being
-- asked, so a selection nobody can check is a selection nobody can correct.
--
-- TWO COLUMNS, DELIBERATELY, because they are two different kinds of thing:
--
--   selection_reason  ONE PLAIN SENTENCE from the model: chosen, runner-up, why. For a
--                     person. Null when there was nothing to choose between, which is not
--                     the same as a choice made for no reason.
--   selection_basis   WHAT THE ORDERING ACTUALLY DID, measured in code: the ranked ids, the
--                     rank basis of the winner and runner-up, what pure trigger-list position
--                     would have picked instead, and whether those differ. This is the part
--                     that can contradict the sentence, which is why it is stored rather than
--                     recomputed: the candidates' dates and scores are on the row, but the
--                     ordering rule will change again and a re-derivation would then answer
--                     for today's rule rather than the one that made this choice.
--
-- Both nullable with no default. A row written before today has neither, and null must read
-- as "this run did not record it", never as "nothing was weighed".

ALTER TABLE public.prospect_research_results
  ADD COLUMN IF NOT EXISTS selection_reason text,
  ADD COLUMN IF NOT EXISTS selection_basis  jsonb;

COMMENT ON COLUMN public.prospect_research_results.selection_reason IS
  'One plain sentence from synthesis: which candidate was chosen, which was runner-up, and why. Null when there was no choice to make.';
COMMENT ON COLUMN public.prospect_research_results.selection_basis IS
  'What the deterministic ordering did: ranked_ids, chosen/runner-up rank basis, and what pure trigger-list position would have chosen. Measured in code, not claimed by the model.';
