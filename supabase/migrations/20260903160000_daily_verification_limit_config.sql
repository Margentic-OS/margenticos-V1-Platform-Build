-- The daily email-verification budget becomes editable config.
--
-- Status: APPLIED (verified live 2026-09-03; production and the test project)
-- Read back: config now holds daily_verification_limit = 10500 and no free_daily_limit.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT WAS WRONG
--
-- src/lib/sourcing/verification-trigger.ts held `const FREE_DAILY_LIMIT = 100`. 100 was the
-- validator's FREE TIER allowance. The account left that tier on 2026-09-01 when 10,500
-- pay-as-you-go credits were bought, so the constant described a plan the account no longer
-- has, and every sweep since has capped its batch against it.
--
-- The active registry row ALREADY carried `config.free_daily_limit = 100`, seeded when the
-- validator was registered. Nothing read it. So the number existed in two places, one of
-- them editable and ignored, and they agreed only because neither had ever been touched.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY THE KEY IS RENAMED RATHER THAN JUST RE-VALUED
--
-- `free_daily_limit` names a tier, not a budget. Leaving the name and changing the number
-- would leave the next reader believing the figure is a vendor free-tier allowance, and
-- that exceeding it is impossible rather than merely billable. The new key says what the
-- value now is: a daily cap WE impose, on an account that bills per call.
--
-- Renaming is safe here precisely because nothing read the old key. The application reads
-- `daily_verification_limit` and falls back to a compiled 100 when it is absent or is not a
-- positive integer, so this migration and the code can land in either order.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHERE 10500 COMES FROM, AND WHAT IT IS NOT
--
-- It is the purchase of 2026-09-01: 10,500 pay-as-you-go credits. That is the only figure
-- in evidence, and it is deliberately not rounded, adjusted or divided into a rate, because
-- any such number would be one this migration invented.
--
-- IT IS A BALANCE, NOT A DAILY ALLOWANCE, and that distinction matters more than the digits.
-- A pay-as-you-go account has no per-day grant to run out of, so there is no vendor number
-- for this key to mirror. Setting the key to the balance therefore makes the DAILY CAP STOP
-- BINDING: the governor becomes DEFAULT_VERIFY_BATCH_SIZE, which is 40 per invocation, and
-- verify-pending runs every 10 minutes, so the arithmetic ceiling is 144 * 40 = 5,760 a day,
-- already below 10,500.
--
-- If a tighter daily ceiling is wanted, it is a commercial decision rather than a code one,
-- and it is now ONE UPDATE ON THIS ROW with no deploy. That is the point of the change.

UPDATE integrations_registry
SET config = (config - 'free_daily_limit')
             || jsonb_build_object('daily_verification_limit', to_jsonb(10500::int)),
    updated_at = now()
WHERE capability = 'can_validate_email'
  AND is_active = true;

-- Read-back belongs in the session that applies this, per CLAUDE.md: assuming the effect of
-- a write instead of reading it back is the mistake this project keeps making.
--   SELECT capability, tool_name, is_active, config
--     FROM integrations_registry
--    WHERE capability = 'can_validate_email';
