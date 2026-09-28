# Research spend — the ledger, and what it has been reconciled against

Last updated: 2026-09-28.

## What this does

`research_usage` is a table that records what each researched prospect actually cost in
model calls. One row per prospect per run. It exists because before it was built, the token
counts were computed in memory by the research agent, returned to the caller, and then
thrown away. The only surviving record of a day's Anthropic spend was the Anthropic console,
which gives one number for the whole account and cannot tell you which prospect, which
stage, or which client it belonged to.

So the point of the table is not accounting for its own sake. It is that a cost question
("what does a prospect cost", "did that change save anything") can now be answered by
reading rows, instead of by estimating.

## What it connects to

- Written by `recordResearchUsage()` in `src/lib/agents/prospect-research-agent-v2.ts`,
  on every path that researches a prospect: the CLI, the inline agent, and the queue.
  `path` says which one, so a figure can be filtered to the production path.
- Priced by `usdForTokens()` and `prospectCostUsd()` in
  `src/lib/agents/research/cost-constants.ts`. That file holds the published per-million
  rates and is the source of truth for them.
- Service-role only. RLS is on, and `anon` and `authenticated` are revoked by name, not
  just from `PUBLIC` — see the database security rules in CLAUDE.md for why revoking from
  `PUBLIC` alone is a silent no-op on Supabase.

## What a row holds

Four jsonb columns, one per stage, each holding the token counts the provider returned:

| Column | The calls it covers |
|---|---|
| `synthesis` | the one synthesis call, which is most of the cost |
| `opening` | writer, floor judge and judge together |
| `followups` | the follow-up writer and the fact-check |
| `web_search` | the web search call's own tokens, plus `search_count` |

Plus `synthesis_batched`, true when synthesis went through the Anthropic Batch API and so
was billed at half price, and `arm`, which is set only by the cost-arm harness and is null
for ordinary production runs.

`synthesis` and `web_search` carry the model they ran on. `opening` and `followups` do not,
because the token counts they accumulate do not carry one. They are priced at
`RESEARCH_SONNET_MODEL`, and the standing rule is that if a stage moves off Sonnet, that
constant and ADR-013 change in the same commit.

## How to price a day

The rates below are copied from `cost-constants.ts`. **They are a second copy, so they can
drift.** If a price changes, change both, in the same commit.

```sql
with rates(model, inp, outp, cw, cr) as (
  values ('claude-sonnet-4-6',          3.00, 15.00,  3.75, 0.30),
         ('claude-opus-4-6',           15.00, 75.00, 18.75, 1.50),
         ('claude-haiku-4-5-20251001',  1.00,  5.00,  1.25, 0.10)
),
rows_in_day as (
  select * from public.research_usage
   where created_at >= '2026-09-26T00:00:00Z' and created_at < '2026-09-27T00:00:00Z'
),
stages as (
  select id, 'synthesis'  as stage, synthesis  as u, synthesis_batched as batched from rows_in_day where synthesis  is not null
  union all select id, 'opening',    opening,    false from rows_in_day where opening    is not null
  union all select id, 'followups',  followups,  false from rows_in_day where followups  is not null
  union all select id, 'web_search', web_search, false from rows_in_day where web_search is not null
)
select s.stage,
       round(sum(
         ((s.u->>'input_tokens')::bigint  * r.inp
        + (s.u->>'output_tokens')::bigint * r.outp
        + coalesce((s.u->>'cache_creation_input_tokens')::bigint, 0) * r.cw
        + coalesce((s.u->>'cache_read_input_tokens')::bigint, 0)     * r.cr) / 1000000.0
         * case when s.batched then 0.5 else 1.0 end
       )::numeric, 4) as token_usd,
       round(sum(coalesce((s.u->>'search_count')::int, 0) * 0.01)::numeric, 4) as search_fee_usd
  from stages s
  join rates r on r.model = coalesce(s.u->>'model', 'claude-sonnet-4-6')
 group by s.stage;
```

Two things that are easy to get wrong and are both in the query above. A cache write costs
1.25x the input rate and a cache read costs 0.1x, so a run that reuses a cached prefix is
cheap but not free. And a web search is billed twice: the tokens it returns, plus a flat
fee of $0.01 for each search, which is a separate line on the console.

## The reconciliation, 26 September 2026 — MEASURED

This is the check that the ledger can be trusted. 26 September was set up as a controlled
day: `process-replies` was paused for the whole UTC day, Doug stayed off the dashboard, and
the only thing running was four cost-arm research runs over one fixed cohort of 40
prospects. So for that one day, the research ledger should account for the entire Anthropic
bill.

| Line | Anthropic console | Ledger, priced from rows | Difference |
|---|---|---|---|
| Token cost | $28.80 | $28.8029 | $0.0029 |
| Web search fees | $0.40 | $0.4000 | $0.0000 |
| **Total** | **$29.20** | **$29.2029** | **$0.0029** |

683 Anthropic calls recorded: 643 counted in the `calls` fields, plus 40 web search calls,
which record a `search_count` rather than a call count.

The difference is 0.0099%, against a pass bar of 5%. It is also entirely explained by the
console rounding to whole cents: $28.8029 displays as $28.80. **At the precision the console
reports, the reconciliation is exact.** Every dollar Anthropic billed that day is
attributable to a recorded call, and the spend divides cleanly across the four arms with
nothing left over.

Every other provider measured zero or near-zero for the same day: Apify $0.0001 across the
whole day with 0 runs, Apollo 0 credits, MyEmailVerifier 0, Bouncer 0.

### What this proves

- The pricing in `cost-constants.ts` matches what Anthropic actually charges, including the
  cache-write and cache-read multipliers and the flat per-search fee.
- Nothing called Anthropic outside the ledger on that day. There is no unrecorded caller
  hiding in the research path.

### What this does NOT prove, and each of these is a real gap

- **It covers research only.** On an ordinary day, document generation runs on Opus, reply
  classification and signal processing run on Haiku, and ICP, buyer criterion, geography and
  fit-dimension derivation all make their own calls. None of those write to
  `research_usage`. So on any normal day the console total will be **higher** than this
  ledger, and that gap is expected rather than a fault. Do not read it as a missing row.
- **The batch discount was not exercised.** Every row that day had
  `synthesis_batched = false`, because the arm runs went through the CLI. The 50% halving in
  the query above is therefore untested against a real bill.
- **The follow-ups stage was not exercised.** `followups` was null on all 154 rows, so the
  follow-up writer and the fact-check are recorded by code that this reconciliation did not
  check against a bill.
- It is one day, on one controlled cohort. It says the instrument reads true; it does not
  make any single day's figure a general one.

## What that day cost, by arm — MEASURED

| Arm | Prospects | Calls | Token $ | Search fees | Total | Per prospect |
|---|---|---|---|---|---|---|
| control | 40 | 180 | $8.7019 | $0.0000 | $8.7019 | $0.2175 |
| arm A, synthesis candidates capped at 4 | 34 | 166 | $9.2406 | $0.0000 | $9.2406 | $0.2718 |
| arm B, synthesis on Haiku | 40 | 116 | $2.2636 | $0.0000 | $2.2636 | $0.0566 |
| arm C, brief web search | 40 | 221 | $8.5968 | $0.4000 | $8.9968 | $0.2249 |
| **All** | 40 | **683** | **$28.8029** | **$0.4000** | **$29.2029** | |

Arm A cost 25% **more** per prospect than the control, not less, and produced no row at all
for 6 of the 40. Arm B was 74% cheaper and was rejected on quality. Arm C was adopted, and
the two rejected switches were deleted rather than left in the code.

### The trap in that table, so nobody reads a saving out of it

**Arm C's total is not comparable to the control's, and it looks like arm C cost more.** It
did, on the day. The control replayed web search findings already in storage, so it paid no
search fees at all, while arm C refetched every search to measure brief mode. The $0.40 is
the price of the measurement, not a cost arm C adds in production.

Arm C's actual saving is in the search count, which is what brief mode changes: **1.00
searches per prospect measured, against 2.83 with brief mode off.** That is what
`WEB_SEARCH_SEARCHES_PER_PROSPECT` and `COST_WEB_SEARCH_TOTAL` in `cost-constants.ts` now
hold, and it takes web search from $0.039 to $0.0205 per prospect.

## What to check if it breaks

- **A day's ledger total that is far below the console.** Expected on any ordinary day, per
  the caveat above, because non-research agents do not write here. Only alarming if the day
  was research-only.
- **A prospect researched with no row.** `recordResearchUsage()` deliberately does not
  throw, so a failed insert loses the row rather than failing the run. It logs at error
  level, so look there first.
- **A total that stops growing when a model is renamed.** It will not silently read zero:
  `rateFor()` prices an unknown model at the most expensive published rate, so the error
  shows up as an overstatement, which is visible, rather than an understatement, which is
  not.
- **Rates that disagree with the console by a constant factor.** The SQL above holds its own
  copy of the rates. Check it against `cost-constants.ts` before suspecting anything else.
