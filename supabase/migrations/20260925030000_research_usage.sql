-- Status: PENDING
-- research_usage: what every model call a research run made actually cost, per prospect.
--
-- ═══ WHY A TABLE AT ALL, WHEN THE NUMBERS WERE ALREADY BEING COMPUTED ════════
--
-- Every Anthropic response carries its usage, and the research agent sums it correctly into
-- ResearchResult.token_usage. That value was then returned in memory and, on two of the
-- three paths, dropped. prospect_research_results has no usage column, so the append-only
-- history of what was researched carried no record of what it cost.
--
-- What DOES survive today is a side effect rather than a design: updateProspect writes
-- `trigger_data = { ...synthesis, judge: opening }`, so synthesis usage lands at
-- prospects.trigger_data->'usage' and the writer/floor/judge usage at
-- trigger_data->'judge'->'usage'. Measured 2026-09-25: 274 of 470 prospects carry it, 105 of
-- them from 2026-09-24. That is how the ~$20 figure in the Backlog row "The in-run spend
-- counter reads about 38 times low" was reconstructed, and it is real data.
--
-- IT IS STILL NOT A RECORD OF RUNS. prospects holds ONE ROW PER PROSPECT, overwritten on
-- every re-research, and this project re-researches constantly: 188 research results were
-- written on 2026-09-24 against 105 prospects carrying usage. So the per-run cost of every
-- superseded run is already gone, and a cost question asked about a cohort cannot be
-- answered from a column that only remembers the last attempt.
--
-- ═══ WHY NOT A COLUMN ON prospect_research_results ═══════════════════════════
--
-- Because a SIGNED-IN CLIENT CAN READ THAT TABLE. Measured 2026-09-25: RLS is on with two
-- SELECT policies for `authenticated`, and clients_read_own_research_results admits any user
-- whose role is 'client' to their own organisation's rows. Our per-prospect model spend is
-- operator data and does not belong on a surface a client can query.
--
-- A column-level REVOKE does not fix it and is worth recording so nobody tries: Postgres
-- table-level SELECT implies every column, including ones added later, and REVOKE SELECT
-- (col) removes only a column-specific grant. Denying one column means revoking table SELECT
-- and re-granting every other column by name, which then silently re-exposes each new column
-- somebody adds. A separate service-only table is the correct shape, and it is the same shape
-- verification_calls already uses for the paid-verification ledger.
--
-- ═══ ONE ROW PER RESEARCH RESULT, AND THE PATH THAT PRODUCED IT ══════════════
--
-- `path` exists so "usage is persisted on every path" is answerable from DATA rather than
-- from reading three call sites and believing the reading. A path missing from this column is
-- a path that is not recording, and that is a query rather than an audit.

CREATE TABLE IF NOT EXISTS public.research_usage (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- CASCADE, because usage describes that run and is meaningless once the run's row is gone.
  research_result_id  uuid NOT NULL UNIQUE
                        REFERENCES public.prospect_research_results(id) ON DELETE CASCADE,
  organisation_id     uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  prospect_id         uuid NOT NULL REFERENCES public.prospects(id) ON DELETE CASCADE,

  -- Which caller produced the run. 'collect' is phase 2 of the Batch API split, whose
  -- synthesis was billed hours earlier and at the 50% batch rate; see synthesis_batch below.
  path                text NOT NULL CHECK (path IN ('cli', 'inline', 'queue', 'collect')),

  -- ── The stages, each holding a TokenUsage: input_tokens, output_tokens,
  --    cache_creation_input_tokens, cache_read_input_tokens, calls. ──────────────
  --
  -- jsonb per stage rather than 20 numeric columns, matching synthesis_batch_entries.usage
  -- and job_queue.spend_detail, so one shape is read the same way everywhere.

  -- One Sonnet call. Zero-valued on a stored-findings reuse, which synthesises nothing.
  synthesis           jsonb NOT NULL,

  -- Writer, floor judge and judge across EVERY attempt, including discarded ones.
  -- ONE ACCUMULATOR AND IT CANNOT BE SPLIT: write-opening.ts records all three into a single
  -- counter (see its `record` helper), so a per-stage split does not exist upstream of here
  -- and inventing three columns would imply a precision the data does not have.
  opening             jsonb NOT NULL,

  -- Follow-up attempts PLUS the fact-check calls they triggered, which write-followups.ts
  -- deliberately adds into the same accumulator so the check can never be billed invisibly.
  -- NULL means no follow-up call was paid for: the template arm, or Email 1 losing to the
  -- template. Distinct from a zeroed object, which would mean a call that cost nothing.
  followups           jsonb,

  -- { input_tokens, output_tokens, model, search_count }. Haiku, not Sonnet, so it is kept
  -- apart from the columns above: the two models are 3x apart and a blended token count
  -- cannot be priced. search_count is the BILLABLE unit, one charged search per
  -- web_search_tool_result block.
  web_search          jsonb NOT NULL,

  -- TRUE when synthesis was billed through the Anthropic Batch API at 50% of standard.
  -- WITHOUT THIS THE TABLE CANNOT BE PRICED. Synthesis is ~90% of the Anthropic cost of a
  -- prospect, and the same token counts mean two different bills depending on which path
  -- produced them. Deriving it from `path` would work today and break the first time the
  -- inline path learns to batch.
  synthesis_batched   boolean NOT NULL DEFAULT false,

  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Cost for one organisation over a window, which is every question this table exists for.
CREATE INDEX IF NOT EXISTS research_usage_org_created_at
  ON public.research_usage (organisation_id, created_at DESC);

-- "Is every path recording?" without a sequential scan once this table is large.
CREATE INDEX IF NOT EXISTS research_usage_path_created_at
  ON public.research_usage (path, created_at DESC);

COMMENT ON TABLE public.research_usage IS
  'Per-research-result token usage for every model call the run made. Service-role only: '
  'this is operator cost data and prospect_research_results is client-readable. '
  'Priced, never storing a price: rates change and a stored dollar figure is a frozen verdict.';

-- ── Privileges ───────────────────────────────────────────────────────────────
-- Service-role only: the operator route and the queue worker own the auth gate. RLS is
-- enabled because it is what actually denies rows today, AND the grants are revoked BY NAME,
-- because Supabase's ALTER DEFAULT PRIVILEGES grants anon and authenticated explicitly and
-- REVOKE ... FROM PUBLIC alone is a silent no-op against those. See CLAUDE.md, "Rule: THE
-- SAME TRAP APPLIES TO TABLES".
ALTER TABLE public.research_usage ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.research_usage FROM PUBLIC;
REVOKE ALL ON TABLE public.research_usage FROM anon, authenticated;
GRANT ALL ON TABLE public.research_usage TO service_role;
