-- Status: APPLIED (verified live 2026-09-25, both projects: hjpvnvjryxdjcfdsfhzy and tidqheqjzvwmrrrebzir)
-- THE FOLLOW-UP OUTCOME, PER EMAIL, BECAUSE ONE SCALAR CANNOT SAY IT.
--
-- WHY. Until 2026-09-25 composition shipped emails 2 and 3 generated together or not at
-- all: one missing column sent BOTH as template. A single `followup_mode` was therefore a
-- complete description of what happened. It no longer is. Each position is now decided on
-- its own, so {2 generated, 3 template} is a real and common outcome, and a scalar has to
-- misreport it in one direction or the other.
--
-- WHAT WENT WRONG, measured. The writer moved to per-email acceptance on 2026-09-25
-- (186452c) and composition was not changed with it. Neither side was wrong alone and no
-- test crossed the seam. Read back the same day: 24 of 104 prospects held stored follow-up
-- copy that could never reach anyone, because the other column was null.
--
-- followup_mode IS KEPT, AND ITS MEANING IS NARROWED ON PURPOSE. sent_sequences.followup_mode
-- is NOT NULL with a CHECK, and the arm comparison it exists for needs one question
-- answered: was this prospect EXPOSED to generated follow-up copy at all. So it now means
-- "at least one follow-up position shipped generated". It is an exposure flag, not a
-- description, and anything that needs to know WHICH position must read followup_modes.
--
-- NULLABLE, NO DEFAULT, for the reason writer_attempts and followup_attempts are: NULL means
-- "not recorded" and an empty object means "composition ran and no follow-up position was
-- evaluated". A default would erase that distinction on every historical row, and every row
-- written before today genuinely predates the per-position verdict.

ALTER TABLE public.prospects
  ADD COLUMN IF NOT EXISTS followup_modes jsonb;

ALTER TABLE public.sent_sequences
  ADD COLUMN IF NOT EXISTS followup_modes jsonb;

COMMENT ON COLUMN public.prospects.followup_modes IS
  'Per follow-up position, what actually shipped: {"2":{"mode":"generated","fell_back_reason":null},"3":{"mode":"template","fell_back_reason":"none_stored"}}. NULL on rows last composed before 2026-09-25. followup_mode beside it is only an exposure flag: generated iff ANY position shipped generated.';

COMMENT ON COLUMN public.sent_sequences.followup_modes IS
  'Per follow-up position, what actually shipped, for the sequence recorded in this row. NULL on rows written before 2026-09-25. followup_mode beside it is only an exposure flag: generated iff ANY position shipped generated.';

COMMENT ON COLUMN public.prospects.followup_mode IS
  'EXPOSURE FLAG, not a description: generated iff at least one follow-up position shipped generated copy. Narrowed 2026-09-25 when positions became independent. Read followup_modes for what each position did.';
