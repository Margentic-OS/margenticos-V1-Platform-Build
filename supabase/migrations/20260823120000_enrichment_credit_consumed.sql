-- Migration: record Apollo credit consumption per prospect, and allow a terminal
--            "we paid, processing did not finish" status.
-- Date: 2026-08-23
--
-- Status: APPLIED (verified live 2026-08-23)
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS FIXES
--
-- Measured, 2026-08-10: 303 enrichments requested across 12 runs against the same
-- ~29 people. 141 credits for 29 prospects, 4.86 each, against Apollo's ceiling of
-- 1 credit per contact. Apollo's own usage endpoint confirms 258 lead credits for
-- the cycle; 141 of them are that one day.
--
-- The mechanism: the credit is spent the moment the bulk_match response returns
-- (adapter-apollo-enrichment.ts, callApolloBulkMatch). enrichment_status was written
-- much later, at the end of enrichAndVerifyProspect, and three early-return paths sat
-- in between:
--   1. the Apollo id returned did not match the source_person_key we sent, so the
--      prospect was never located and the loop hit `continue`
--   2. the identity-field UPDATE failed and the function returned early
--   3. the held_missing bulk UPDATE failed and was logged, not retried
-- Each one leaves enrichment_status NULL after the money is gone. enrichment-trigger
-- then re-selects NULL-status prospects once the 30-minute lock goes stale. It checked
-- the lock; it never checked whether we had already paid for that person.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY A COLUMN AND NOT A LEDGER TABLE
--
-- The guard asks exactly one question: "has this person ever cost us money?" That has
-- one answer per prospect, and a column answers it inside the SELECT the trigger
-- already runs. A ledger would need a join or a second round trip on the hot path to
-- return the same boolean.
--
-- Run-level history already exists and is not being duplicated here: enrichment_runs
-- holds batch_size, credits_consumed and status per run, and prospects.enrichment_run_id
-- links each prospect to the run that touched it. A ledger table would re-record that
-- linkage to add one genuinely new fact.
--
-- A new table would also need its own RLS policies and its own REVOKE/GRANT pass
-- (CLAUDE.md, learned 2026-06-05). A column inherits the RLS already on prospects,
-- which is correct and already covered.
--
-- Timestamp rather than boolean: IS NOT NULL answers "has it" at no extra cost, and the
-- value additionally answers "when". A boolean throws that away for the same storage.
--
-- WHEN A LEDGER BECOMES THE RIGHT SHAPE: if deliberate re-enrichment ever ships (for
-- example refreshing emails that have gone stale), we will need charge COUNT and per-charge
-- history, which a single column cannot hold. At that point promote to
-- enrichment_credit_events and keep this column as a denormalised "first charged" cache.
-- Backlogged, not built speculatively.

-- ─────────────────────────────────────────────────────────────────────────────
-- COLUMN

ALTER TABLE public.prospects
  ADD COLUMN IF NOT EXISTS enrichment_credit_consumed_at timestamptz;

COMMENT ON COLUMN public.prospects.enrichment_credit_consumed_at IS
  'Set when an Apollo bulk_match response that consumed credits included this prospect''s '
  'batch. Never cleared by application code. enrichment-trigger refuses to re-select any '
  'prospect where this is NOT NULL, so a paid-for person can never be bought twice.';

-- The trigger selects on: organisation_id + sourcing_review_status + enrichment_status IS
-- NULL + enrichment_credit_consumed_at IS NULL. Partial on the two NULL predicates, which
-- is the only combination that query cares about, so the index stays small: it holds just
-- the prospects still awaiting a first enrichment, not the whole table.
CREATE INDEX IF NOT EXISTS prospects_enrichment_selectable_idx
  ON public.prospects (organisation_id, sourcing_review_status)
  WHERE enrichment_status IS NULL AND enrichment_credit_consumed_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- STATUS FLOOR
--
-- 'held_incomplete' means: Apollo charged us, and the run did not get far enough to
-- reach a real verdict. It is written immediately after the API call returns, before any
-- step that can throw, and enrichAndVerifyProspect overwrites it with the true outcome
-- ('enriched', 'held_duplicate', 'held_no_email', 'held_unverified') a moment later.
--
-- It exists so that enrichment_status can never be observed as NULL after money has been
-- spent. A prospect resting in this state is not a failure to investigate away: it is the
-- record of a batch that paid and then broke, and it is deliberately terminal so the
-- stale-lock reclaim leaves it alone.
--
-- The CHECK has to be recreated rather than extended; Postgres has no ADD VALUE for a
-- CHECK the way it has for an enum.

ALTER TABLE public.prospects
  DROP CONSTRAINT IF EXISTS prospects_enrichment_status_check;

ALTER TABLE public.prospects
  ADD CONSTRAINT prospects_enrichment_status_check
  CHECK (enrichment_status = ANY (ARRAY[
    'enriched'::text,
    'held_unverified'::text,
    'held_no_email'::text,
    'held_missing'::text,
    'held_duplicate'::text,
    'held_incomplete'::text
  ]));

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICATION
--
-- Expected: one column row (timestamptz, nullable), one index row, and a CHECK
-- definition listing all six statuses including held_incomplete.

SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name   = 'prospects'
   AND column_name  = 'enrichment_credit_consumed_at';

SELECT indexname, indexdef
  FROM pg_indexes
 WHERE schemaname = 'public'
   AND tablename  = 'prospects'
   AND indexname  = 'prospects_enrichment_selectable_idx';

SELECT pg_get_constraintdef(con.oid) AS enrichment_status_check
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
 WHERE rel.relname = 'prospects'
   AND con.conname = 'prospects_enrichment_status_check';
