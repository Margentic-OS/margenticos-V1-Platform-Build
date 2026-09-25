-- Status: PENDING
-- research_usage.arm: which cost experiment produced this row.
--
-- ═══ WITHOUT THIS THE MEASUREMENT DAY CANNOT BE READ BACK ════════════════════
--
-- On 2026-09-26 one UTC day carries a baseline plus four arms over overlapping prospect sets.
-- research_usage already records `path`, but every arm runs through the same path, so the
-- rows would be indistinguishable and the reconciliation would have nothing to group by.
--
-- NULLABLE, AND NULL IS THE MEANING OF "ORDINARY PRODUCTION WORK". Every row written before
-- today is ordinary production work, and a default of 'baseline' would retroactively relabel
-- them as part of an experiment that had not happened yet. A backfill would be worse: it
-- would be inventing a fact.
--
-- FREE TEXT, NOT AN ENUM. The arms are named by the operator running them and a new arm must
-- not need a migration. The constraint that matters is length, so a runaway string cannot
-- turn the ledger into a log.
ALTER TABLE public.research_usage
  ADD COLUMN IF NOT EXISTS arm text
    CONSTRAINT research_usage_arm_len CHECK (arm IS NULL OR char_length(arm) BETWEEN 1 AND 64);

COMMENT ON COLUMN public.research_usage.arm IS
  'Which cost experiment wrote this row. NULL means ordinary production work, which is what '
  'every row before 2026-09-25 is. Never backfilled: a label invented after the fact is not a '
  'measurement.';

-- Grouping one day's arms, which is the only query this column exists for.
CREATE INDEX IF NOT EXISTS research_usage_arm_created_at
  ON public.research_usage (arm, created_at DESC)
  WHERE arm IS NOT NULL;

-- Privileges are inherited from the table and are NOT re-granted here. research_usage is
-- service-role only with RLS on and zero policies, and anon and authenticated were revoked
-- by name when it was created. A new column on an existing table changes none of that, and
-- re-stating a GRANT would imply it does.

-- ═══ AN ARM ROW HAS NO RESEARCH RESULT, AND IT MUST NOT INVENT ONE ═══════════
--
-- research_result_id was NOT NULL, which is right for production: usage describes a run and a
-- run wrote a row. An arm is different, and the difference is the whole point of running it
-- read-only.
--
-- An arm re-synthesises a prospect from RAW SOURCES ALREADY ON FILE. If it wrote a
-- prospect_research_results row to satisfy this foreign key, that row would become the newest
-- one holding evidence, and loadStoredFindings would carry an ARM's candidates forward into
-- the next production run. A measurement that changes the thing it measures is not a
-- measurement. It would also put an experiment's verdict next to shipped copy in the audit
-- history, which is how a reader later concludes the wrong thing about what a prospect was
-- sent.
--
-- So the column becomes nullable, and a CHECK states the rule rather than leaving it to
-- whoever writes the next insert: a PRODUCTION row must still link to its result, and only an
-- arm row may omit it. Postgres allows many NULLs under the existing UNIQUE, so arm rows do not
-- collide with each other.
ALTER TABLE public.research_usage
  ALTER COLUMN research_result_id DROP NOT NULL;

ALTER TABLE public.research_usage
  DROP CONSTRAINT IF EXISTS research_usage_production_rows_link_to_a_result;

ALTER TABLE public.research_usage
  ADD CONSTRAINT research_usage_production_rows_link_to_a_result
    CHECK (arm IS NOT NULL OR research_result_id IS NOT NULL);

COMMENT ON COLUMN public.research_usage.research_result_id IS
  'The run this usage describes. NULL only on an arm row, which re-synthesises from raw sources '
  'already on file and deliberately writes no research result: an arm row would otherwise become '
  'the newest row holding evidence and leak an experiment into the next production run.';
