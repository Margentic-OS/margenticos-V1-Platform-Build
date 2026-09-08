-- Status: APPLIED to BOTH projects.
--   production  hjpvnvjryxdjcfdsfhzy  (verified live 2026-09-07)
--   test        tidqheqjzvwmrrrebzir  (verified live 2026-09-08)
-- Read-back, both: 3 columns present, CHECK prospects_send_hold_complete present, partial
-- index prospects_send_hold_at_idx present. Constraint proved to REJECT a hold with a null
-- reason, inside a transaction that was then rolled back so nothing was kept.
--
-- THE TEST PROJECT WAS MISSED FOR A DAY, and that is worth recording rather than quietly
-- fixing. This migration went to production only on 2026-09-07. The suite runs against the
-- TEST project, so from 2026-09-07 until 2026-09-08 any live-database test touching these
-- columns would have failed on a missing column.
--
-- Measured before assuming the worst: none did. The two baseline runs on 2026-09-08 at
-- 8bc5941 reported 3,401 tests across 245 files with 6 and 8 failures respectively, and
-- NEITHER failure set mentions send_hold. The only tests reading the column used a fake, so
-- the gap was real and latent rather than red. It stopped being latent the moment a live
-- test was written for the operator stop, which is what surfaced it.
-- A DURABLE, OPERATOR-SET HOLD ON SENDING TO ONE PROSPECT.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY THIS EXISTS
--
-- prospects.email_send_eligible is a MATERIALISED verdict (ADR-034). resolveSendEligibility
-- recomputes it from scratch every time a prospect is verified, so anything written into it
-- by hand survives only until the next re-verification, and is then overwritten with no log
-- line, because from the resolver's point of view it is simply computing the right answer
-- from the evidence.
--
-- Measured on 2026-09-07: three prospects (one AU, two CA) read email_send_eligible = false
-- with email_send_ineligible_reason = NULL, operator_override_at = NULL and suppressed_at =
-- NULL, while carrying independent_email_status = 'Valid', which the resolver maps to
-- eligible. EXCLUDED_COUNTRIES is ['DE'] only, so neither country is excluded in code.
-- Nothing in the codebase was holding them. A manual UPDATE was, and the next
-- re-verification of any of the three would have silently undone it.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY NOT email_send_ineligible_reason
--
-- That column is already overloaded. TWO readers treat any non-null value there as a
-- COUNTRY EXCLUSION and nothing else:
--
--   src/lib/sourcing/send-eligibility-policy.ts   the research spend gate
--   src/lib/operator/prospect-status.ts           the operator display, maps it to
--                                                 'excluded_country'
--
-- Recording a hand-set hold there would make these three rows report as country exclusions,
-- which is the exact rule-versus-hand-edit confusion this change exists to remove. The
-- resolver's own doc comment already names this trap.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY NOT operator_override_*
--
-- operator_override_at / _by / _reason / _tier are the TIER override (ADR-037), written only
-- by /api/operator/prospects/override-tier. Reusing them for a send hold would repeat the
-- same overload one column over, and a future reader could not tell which of two unrelated
-- operator decisions a populated row recorded.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT THIS DELIBERATELY DOES NOT DO
--
-- It NAMES NO COUNTRY, and takes no legal position on any jurisdiction. A hold is
-- per-prospect and carries the operator's recorded reason. Whether Canada and Australia
-- belong on an exclusion list is an open legal question, tracked separately, and it must not
-- be answered as a side effect of making a manual edit durable.
--
-- EXCLUDED_COUNTRIES is unchanged by this migration and by the commit that carries it.

ALTER TABLE public.prospects
  ADD COLUMN IF NOT EXISTS send_hold_at     timestamptz,
  ADD COLUMN IF NOT EXISTS send_hold_by     uuid,
  ADD COLUMN IF NOT EXISTS send_hold_reason text;

COMMENT ON COLUMN public.prospects.send_hold_at IS
  'When an operator placed a durable hold on sending to this prospect. Non-null means held. '
  'Read by resolveSendEligibility BEFORE the country rule and before every verification '
  'verdict, so re-verification cannot clear it. Never set by an automated path.';

COMMENT ON COLUMN public.prospects.send_hold_by IS
  'The operator who placed the hold. NULL means unattributed: the hold is real but the actor '
  'was not recorded, which is the case for holds applied by direct UPDATE before this column '
  'existed. NULL is never inferred or backfilled with a guess.';

COMMENT ON COLUMN public.prospects.send_hold_reason IS
  'Free text: why this prospect is held. Required in practice for any new hold. This is the '
  'column that lets a future reader tell a RULE from a HAND EDIT, which is the defect that '
  'motivated the change: a row held with no reason is indistinguishable from a bug.';

-- A hold without a timestamp is not a hold, and a timestamp without a reason is the defect
-- this migration exists to remove. Enforced so the pairing cannot drift.
--
-- send_hold_by is deliberately NOT in this constraint: an unattributed hold must remain
-- expressible, because three of them already exist and refusing them would mean either
-- losing the hold or inventing an actor.
ALTER TABLE public.prospects
  DROP CONSTRAINT IF EXISTS prospects_send_hold_complete;

ALTER TABLE public.prospects
  ADD CONSTRAINT prospects_send_hold_complete CHECK (
    (send_hold_at IS NULL AND send_hold_reason IS NULL)
    OR
    (send_hold_at IS NOT NULL AND send_hold_reason IS NOT NULL)
  );

-- Held prospects are a small set that an operator needs to enumerate. Partial index so it
-- costs nothing on the overwhelming majority of rows, which are not held.
CREATE INDEX IF NOT EXISTS prospects_send_hold_at_idx
  ON public.prospects (send_hold_at)
  WHERE send_hold_at IS NOT NULL;
