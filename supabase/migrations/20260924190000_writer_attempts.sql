-- Status: APPLIED (verified live 2026-09-24, both projects: hjpvnvjryxdjcfdsfhzy and tidqheqjzvwmrrrebzir)
-- EVERY WRITER ATTEMPT, INCLUDING THE ONES THAT WERE THROWN AWAY.
--
-- WHY A COLUMN AND NOT A TABLE. Named explicitly per the architectural-decision rule.
-- An attempt has no lifecycle of its own: it is created with one research result, read
-- with it, and has no meaning apart from it. A separate table would add RLS policies and
-- grants for a row nothing queries independently, and every read would be a join. The
-- neighbouring `candidates` column already stores a per-result array of objects the same
-- way, for the same reason: rejected candidates are kept so the SELECTION is auditable,
-- and this keeps the rejected attempts so the WRITING is.
--
-- WHAT IS IN IT, per element: the attempt index, how it ended ('gated', 'floored' or
-- 'compared'), the deterministic gate failures, the observation, bridge, question and
-- subject the attempt produced, the subject its own soft gate discarded, and the judge's
-- verdict with its reasoning for that comparison.
--
-- WHY IT IS WORTH STORING. The callback that reports these has existed for a while and no
-- production caller passed one, so a rejected attempt's text lived inside the loop and was
-- overwritten by the next iteration. A prospect that fell back to the approved template
-- left a verdict with no text behind it: the gate codes said an attempt failed and never
-- said what failed. Every question asked of the runs of 2026-09-24 needed a second paid
-- run of the writer to answer, and the answer to one of them, that the observation gates
-- contradicted each other and left no legal move, was only visible once the four attempts
-- of one prospect could be read side by side.
--
-- NO DEFAULT AND NULLABLE. A row written before this column existed reads back NULL, which
-- is "not recorded", and an empty array means "the writer ran and made no attempt", which
-- cannot happen but is a different claim. A default of '[]' would erase that distinction on
-- every historical row and make the backfill look complete.
ALTER TABLE public.prospect_research_results
  ADD COLUMN IF NOT EXISTS writer_attempts jsonb;

COMMENT ON COLUMN public.prospect_research_results.writer_attempts IS
  'Every writer attempt in order, rejected ones included: kind, gate_failures, the text produced, and the judge verdict with reasoning. NULL on rows written before 2026-09-24.';
