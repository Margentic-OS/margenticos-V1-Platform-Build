-- Status: APPLIED (verified live 2026-09-24, both projects: hjpvnvjryxdjcfdsfhzy and tidqheqjzvwmrrrebzir)
-- WHERE the prospect's reason came from.
--
-- The field existed on the TYPE for a day and never on the row, so the only way to read a
-- run's fallback split was to grep the run log. A value declared and never written is the
-- shape this project keeps finding, and it was introduced in the same commit that fixed
-- three others like it.
--
-- 'relevance_fallback' is the one worth watching: it means nothing matched a trigger, so the
-- writer reads relevance_reason, which is derived from the ICP push forces and is the only
-- remaining path that can reintroduce a claim about the reader's time or who does their
-- selling. It is logged at warn when it happens AND recorded here, because a log line is
-- gone by the next run and a column is not.
ALTER TABLE public.prospect_research_results
  ADD COLUMN IF NOT EXISTS prospect_reason_source text;
