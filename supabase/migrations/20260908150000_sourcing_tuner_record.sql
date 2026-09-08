-- Status: NOT YET APPLIED
-- The record a sourcing tuning run writes. NOTHING READS IT YET, deliberately.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS IS FOR
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The tuner proposes a search plan. A human approves it. Approval is not built here and
-- neither is any consumer: no code reads tuning_runs.plan, and sourcing is untouched.
-- That is on purpose. A plan that something started consuming before a person had ever
-- read one would be a spec change with no approval step, which is the one thing this
-- work is not allowed to be.
--
-- The shape is chosen so a consumer CAN exist later without a migration: the plan is one
-- jsonb column, the staleness marker beside it is three plain columns, and a reader needs
-- nothing else to decide whether the plan still describes the document it was built from.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THE STALENESS MARKER IS THREE COLUMNS AND NOT A FOREIGN KEY
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A client's search settings are rebuilt from their ICP document on every approval,
-- revision and revert (persistIcpFilterSpec). The document id does NOT change when that
-- happens; the row is updated in place, so a foreign key would still resolve and still
-- look fine while describing a document that has since moved underneath it.
--
-- MEASURED, not hypothetical. Between 2026-09-07 and 2026-09-08 one live organisation's
-- ICP went from version 4 to version 8 and its reachable population fell from 142 people
-- to 1. A plan built on the seventh, holding only that document's id, would have reported
-- itself current on the eighth while being wrong about everything that matters.
--
-- So the marker records the id AND the version AND the updated_at it was built from, and
-- staleness is decided by comparing all three against the document as it stands now. Any
-- of the three differing is stale.

-- ── The run ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.tuning_runs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id          uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  started_at               timestamptz NOT NULL DEFAULT now(),
  completed_at             timestamptz,

  -- 'operator_manual'  an operator asked for this client to be tuned.
  -- 'instruction'      an operator described something wrong with a result in prose.
  trigger_type             text NOT NULL CHECK (trigger_type IN ('operator_manual', 'instruction')),

  -- The complaint EXACTLY as it was written, and separately what the tuner did with it.
  -- Kept apart because "what was asked" and "what was done" are different facts and the
  -- interesting case is when they differ. A tuner that could not do what was asked records
  -- the request verbatim and says so in the resolution rather than doing something adjacent.
  instruction_text         text,
  instruction_resolution   text,

  -- ── The staleness marker. See the header. ──
  icp_document_id          uuid REFERENCES public.strategy_documents(id) ON DELETE SET NULL,
  icp_document_version     text,
  icp_document_updated_at  timestamptz,

  -- ── The outcome ──
  --
  -- EVERY TERMINAL STATE IS DISTINCT AND NAMED. "Gave up" must never render like
  -- "accepted", which is why there is no boolean here and no nullable success flag: the
  -- only way to read the outcome is to read which of these it was.
  terminal_state           text CHECK (terminal_state IN (
    'accepted',
    'population_too_small_for_contract',
    'population_effectively_empty',
    'no_taxonomy_bucket_fits',
    'document_unresolved_fields_block_search',
    'no_round_improved',
    'judge_unreliable',
    'name_signal_too_low',
    'budget_exhausted',
    'lookup_budget_exhausted',
    'provider_ignored_a_parameter',
    'rate_limit_reached',
    'forbidden_change_required',
    'failed'
  )),
  terminal_reason          text,

  -- ── The two population figures, on every run. ──
  --
  -- BOTH, ALWAYS, and that is the point of having two columns rather than one. The
  -- baseline alone cannot tell "this search is too tight" from "this audience does not
  -- exist"; the ceiling is the same query with the buyer constraints relaxed, so the gap
  -- between them is the measured answer to that question instead of an inference.
  baseline_population      integer,
  ceiling_population       integer,

  -- ── What the run cost ──
  rounds_run               integer NOT NULL DEFAULT 0,
  model_calls              integer NOT NULL DEFAULT 0,
  -- BILLABLE SEARCHES RETURNED, not lookups attempted. Measured 2026-09-08: the provider's
  -- own max_uses parameter is not a hard bound, returning 15 searches for 9 capped lookups
  -- (1.67x). Recording attempts would understate the bill by two thirds.
  billable_searches        integer NOT NULL DEFAULT 0,
  provider_calls           integer NOT NULL DEFAULT 0,

  -- The proposal. NOTHING READS THIS. See the header.
  plan                     jsonb,

  -- ── Columns a human fills in afterwards. Empty by design. ──
  --
  -- There is no learning mechanism here and none is being built. These exist so that when
  -- one is built there is something to learn FROM, and so that a person's disagreement
  -- with the tuner is recorded in the same row as the tuner's own conclusion rather than
  -- in a thread nobody can query.
  operator_verdict         text CHECK (operator_verdict IN ('agree', 'disagree', 'partly')),
  operator_note            text,
  operator_reviewed_at     timestamptz,

  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tuning_runs_org_started_idx
  ON public.tuning_runs (organisation_id, started_at DESC);

-- ── The rounds ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.tuning_rounds (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                 uuid NOT NULL REFERENCES public.tuning_runs(id) ON DELETE CASCADE,

  -- Round zero is free: it makes no model call and no web lookup. Recording the kind means
  -- a reader can check that ordering held rather than trusting that it did.
  round_index            integer NOT NULL,
  kind                   text NOT NULL CHECK (kind IN ('zero', 'adjust')),
  started_at             timestamptz NOT NULL DEFAULT now(),
  completed_at           timestamptz,

  population             integer,

  -- ── Item-level differencing. ──
  --
  -- WEAK AND REDUNDANT ARE SEPARATE KEYS INSIDE THIS OBJECT AND MUST STAY SEPARATE.
  -- An item whose removal does not move the count is REDUNDANT: its matches are covered by
  -- its siblings. An item with a low standalone count is WEAK: it finds almost nobody.
  -- Only the second is evidence of a targeting fault. Measured 2026-09-08, one live
  -- organisation carries a title scoring 4,068 alone whose removal changes the total by
  -- zero; treating that as a bad item would delete a perfectly good constraint.
  differencing           jsonb,

  -- Per-tier counts and the cross product: rows matching the union query that belong to
  -- neither tier. Measured at 21.9% of one live organisation's sourced population.
  tier_counts            jsonb,

  -- Read from the ICP document's content at round zero. Nothing else in the codebase reads
  -- these, and they are in scope at the moment the search is built.
  unresolved_fields      jsonb,

  change_proposed        jsonb,
  change_reason          text,

  -- The judged sample: one entry per sampled row, carrying the verdict, the reason, and
  -- the lookup text if one was made. Stored so a human can see what the judge read and
  -- disagree with it.
  judged_sample          jsonb,
  judge_resolved_sample  integer,
  judge_agreement        numeric,
  -- NULL until there are enough resolved answers to report one. A rate computed on a
  -- handful is noise presented as a finding; the existing sanity band refuses the same way.
  judge_reliable         boolean,

  model_calls            integer NOT NULL DEFAULT 0,
  billable_searches      integer NOT NULL DEFAULT 0,
  provider_calls         integer NOT NULL DEFAULT 0,

  -- A human's note on this specific round. Empty by design, same reason as on the run.
  operator_note          text,

  created_at             timestamptz NOT NULL DEFAULT now(),

  UNIQUE (run_id, round_index)
);

CREATE INDEX IF NOT EXISTS tuning_rounds_run_idx
  ON public.tuning_rounds (run_id, round_index);

-- ── Privileges ───────────────────────────────────────────────────────────────
--
-- SERVICE ROLE ONLY. Both tables are written by an operator-triggered server route and
-- read by nothing. No client ever sees a tuning run.
--
-- RLS IS ENABLED AND THE GRANTS ARE REVOKED BY NAME, both, because either alone is one
-- layer. Supabase runs ALTER DEFAULT PRIVILEGES on the public schema granting anon and
-- authenticated at creation time, so REVOKE FROM PUBLIC is a silent no-op on its own: the
-- grant it removes was never there. The by-name REVOKE is the one that does the work, and
-- FROM PUBLIC is kept because it costs nothing and covers a future role that inherits it.

ALTER TABLE public.tuning_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tuning_runs FROM PUBLIC;
REVOKE ALL ON TABLE public.tuning_runs FROM anon, authenticated;
GRANT ALL ON TABLE public.tuning_runs TO service_role;

ALTER TABLE public.tuning_rounds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tuning_rounds FROM PUBLIC;
REVOKE ALL ON TABLE public.tuning_rounds FROM anon, authenticated;
GRANT ALL ON TABLE public.tuning_rounds TO service_role;

-- Read the privileges back in BOTH directions before trusting this migration. Checking
-- only the role that must have it proves nothing about who else does, which is the exact
-- shape of the 2026-08-24 incident.
--
--   SELECT has_table_privilege('service_role',  'public.tuning_runs', 'SELECT'),  -- t
--          has_table_privilege('service_role',  'public.tuning_runs', 'INSERT'),  -- t
--          has_table_privilege('anon',          'public.tuning_runs', 'SELECT'),  -- f
--          has_table_privilege('anon',          'public.tuning_runs', 'INSERT'),  -- f
--          has_table_privilege('authenticated', 'public.tuning_runs', 'SELECT'),  -- f
--          has_table_privilege('authenticated', 'public.tuning_runs', 'UPDATE'),  -- f
--          has_table_privilege('authenticated', 'public.tuning_runs', 'DELETE');  -- f
