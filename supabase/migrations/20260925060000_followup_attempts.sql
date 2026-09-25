-- Status: APPLIED (verified live 2026-09-25, both projects: hjpvnvjryxdjcfdsfhzy and tidqheqjzvwmrrrebzir)
-- EVERY FOLLOW-UP ATTEMPT, INCLUDING THE PROSE THAT WAS REJECTED.
--
-- WHY. FollowupResult.attempts has carried the full text of every attempt, its gate
-- failures and its fact-check verdict since the fact-check shipped, and produce-opening has
-- passed it up as `followup_attempts` the whole time. Nothing stored it. It is the same
-- shape as `token_usage` one field along: computed on every run, returned, and thrown away.
--
-- WHAT IT COST, measured. The audit of the 44 follow-up pairs that fell back on 2026-09-25
-- could classify 71 of 77 gate hits and had to mark SIX as UNSURE, for one reason: those
-- gate messages carry no quoted sentence, the prose that tripped them is discarded, and
-- there was no route back to it. Email 1 has had writer_attempts since 2026-09-24 and its
-- rejections can be read months later; follow-ups could not be read the next hour.
--
-- WHAT IS IN IT, per element: the attempt index, the email 2 and email 3 prose as scrubbed
-- and parsed, the gate failures for each, and the fact-check's claims and failures for that
-- attempt, with null meaning the fact-check did not run because the deterministic gates had
-- already rejected the attempt.
--
-- NULLABLE, NO DEFAULT, for the reason writer_attempts is: NULL means "not recorded" and an
-- empty array means "the writer ran and produced nothing". A default would erase that
-- distinction on every historical row.
ALTER TABLE public.prospect_research_results
  ADD COLUMN IF NOT EXISTS followup_attempts jsonb;

COMMENT ON COLUMN public.prospect_research_results.followup_attempts IS
  'Every follow-up attempt in order, rejected prose included: email2, email3, failures2, failures3, and the fact-check verdict. NULL on rows written before 2026-09-25.';
