-- Status: APPLIED (verified live 2026-09-15) to production hjpvnvjryxdjcfdsfhzy AND the test
--   database tidqheqjzvwmrrrebzir. Read back on both: column_default is 'USD'::text, and no
--   organisation holds a non-USD currency. Production read back 5 organisations, all USD.
--
-- The currency is USD. Decided 2026-09-15.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY A MIGRATION AND NOT JUST AN UPDATE
--
-- The five existing organisations were set to USD by hand on 2026-09-15. That alone does
-- not hold: organisations.currency carried DEFAULT 'GBP', so the next organisation created
-- without an explicit currency would have been GBP again, and the sweep would have decayed
-- one row at a time with nothing reporting it.
--
-- This is the inverse of the ADR-034 shape. There the rule changed and the existing rows
-- kept their old verdict. Here the rows were changed and the rule that produces new ones
-- was left alone. Both end in the same place: a correction that does not survive contact
-- with the next write.
--
-- So this file changes BOTH, and the UPDATE is written to be re-runnable so the test
-- project and any fresh database reach the same state as production.
--
-- The CHECK still admits GBP and EUR. Narrowing it would be destructive, it is not what was
-- decided, and src/lib/currency/format-currency.ts renders all three deliberately: the fix
-- is "read the column", not "ban the pound".

-- ── 1. New organisations default to USD ─────────────────────────────────────

ALTER TABLE public.organisations ALTER COLUMN currency SET DEFAULT 'USD';

COMMENT ON COLUMN public.organisations.currency IS
  'The currency every money figure on this client''s dashboard renders in. USD is the '
  'decided default (2026-09-15). GBP and EUR remain valid so an existing client is never '
  'silently re-denominated. Read by src/lib/currency/format-currency.ts; never assume a '
  'symbol at a render site.';

-- ── 2. Existing organisations ───────────────────────────────────────────────
--
-- Idempotent: the WHERE makes a second run a no-op rather than a pointless rewrite, and
-- keeps updated_at honest on rows that did not change.

UPDATE public.organisations
   SET currency = 'USD', updated_at = now()
 WHERE currency IS DISTINCT FROM 'USD';

-- ── Verify, both halves ─────────────────────────────────────────────────────
--
--   SELECT column_default FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='organisations' AND column_name='currency';
--   -- expect 'USD'::text
--
--   SELECT currency, count(*) FROM public.organisations GROUP BY currency;
--   -- expect a single row: USD
