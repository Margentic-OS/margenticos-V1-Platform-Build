-- Status: APPLIED (verified live 2026-09-14)
--   production hjpvnvjryxdjcfdsfhzy: 7 new columns present, the CHECK admits
--     no_combination_reached_the_standard and still admits forbidden_change_required.
--   test       tidqheqjzvwmrrrebzir: identical read-back.
--   Read from the catalogs in both, not from this file: the constraint definition was
--   matched for one NEW value and one OLD one, because widening a CHECK by replacing it is
--   exactly how the old values get dropped without anyone noticing.
--
-- The sampler's own outcomes, and the figure it exists to produce.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THIS IS NEEDED BEFORE ANYTHING CAN BE PERSISTED
-- ─────────────────────────────────────────────────────────────────────────────
--
-- tuning_runs was built for the older differencing loop. Two things stop the search sampler
-- writing to it at all:
--
--   1. terminal_state's CHECK lists that loop's outcomes. Five of the sampler's ten are not
--      among them, including the two ordinary ones: a run that measures a fit rate cleanly
--      ends 'no_combination_reached_the_standard', and a run refused for a small audience
--      ends 'audience_cannot_support_the_work'. Both would be rejected by the constraint.
--
--   2. There is nowhere to put the fit figure. The whole point of persisting a run is so the
--      next one can be compared with it, and a comparison needs the rate, the interval around
--      it, and how many rows the rate was computed from.
--
-- Additive only: every column is nullable and the CHECK is widened, never narrowed, so rows
-- written by the older loop stay valid and readable.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THE INTERVAL IS STORED AND NOT RECOMPUTED ON READ
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A reader comparing two runs needs to know whether they differ by more than the measurement
-- can see. Recomputing that later means re-deriving it from counts, and the counts a run
-- reports are the counts AFTER its own resolution rules ran. Storing the interval the run
-- actually reported keeps the comparison honest even if those rules change afterwards.

ALTER TABLE public.tuning_runs DROP CONSTRAINT IF EXISTS tuning_runs_terminal_state_check;

ALTER TABLE public.tuning_runs ADD CONSTRAINT tuning_runs_terminal_state_check
  CHECK (terminal_state IN (
    -- the differencing loop's outcomes, unchanged
    'accepted',
    'population_too_small_for_contract',
    'population_effectively_empty',
    'no_taxonomy_bucket_fits',
    'document_unresolved_fields_block_search',
    'no_round_improved',
    'judge_unreliable',
    'name_signal_too_low',
    'wall_clock_exhausted',
    'lookup_budget_exhausted',
    'provider_ignored_a_parameter',
    'rate_limit_reached',
    'forbidden_change_required',
    'failed',
    -- the search sampler's, added 2026-09-14
    'audience_cannot_support_the_work',
    'no_combination_reached_the_standard',
    'derivation_refused',
    'spend_cap_reached',
    'taxonomy_cannot_express_the_document'
  ));

-- The figure, and what it was measured from.
ALTER TABLE public.tuning_runs ADD COLUMN IF NOT EXISTS sample_size        integer;
ALTER TABLE public.tuning_runs ADD COLUMN IF NOT EXISTS fit_sampled_rows   integer;
ALTER TABLE public.tuning_runs ADD COLUMN IF NOT EXISTS fit_resolved_rows  integer;
ALTER TABLE public.tuning_runs ADD COLUMN IF NOT EXISTS fit_of_resolved    numeric;
ALTER TABLE public.tuning_runs ADD COLUMN IF NOT EXISTS fit_interval_low   numeric;
ALTER TABLE public.tuning_runs ADD COLUMN IF NOT EXISTS fit_interval_high  numeric;

-- Which standard the rows were graded against. A rate measured against a rubric derived for
-- that run alone is not comparable with one measured against the client's stored conditions,
-- and a reader must be able to tell which they are looking at.
ALTER TABLE public.tuning_runs ADD COLUMN IF NOT EXISTS rubric_source text
  CHECK (rubric_source IS NULL OR rubric_source IN ('stored_conditions', 'derived_this_run'));

COMMENT ON COLUMN public.tuning_runs.fit_of_resolved IS
  'Share of the resolved sample judged a fit. Compare runs on this, never on fit of all sampled, which moves with the research success rate too.';
COMMENT ON COLUMN public.tuning_runs.rubric_source IS
  'stored_conditions: graded against the client''s stored fit dimensions, stable between runs. derived_this_run: graded against a rubric derived by a model call in that run, which is not comparable across runs.';
