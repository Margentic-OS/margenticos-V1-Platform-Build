# Prospect Research Agent v2 — Current State

Last updated: April 24 2026.

## Summary

Phase 1 complete. Production-ready for client zero scale (50–500 prospects per batch). Not yet tested on real dogfood data.

## Key files

- `src/agents/research/synthesize.ts` — Sonnet-powered synthesis with value prop alignment filter
- `src/agents/research/synthesis-prompt.ts` — Full prompt with examples (Garrett, Bruce, Rich)
- `src/lib/agents/tools/` — Source handlers (Apify LinkedIn, Apollo, Brave+Anthropic web search, website fetcher with Jina.ai fallback)
- `src/lib/agents/prospect-research-agent-v2.ts` — Batch orchestrator with parallelism
- `src/lib/style/customer-facing-style-rules.ts` — Shared style enforcement (em dashes, AI tells)
- `src/lib/composition/compose-sequence.ts` — Composition with bridge + personalized CTA
- `src/lib/composition/personalize.ts` — Haiku-powered bridge + CTA generator

## Key architectural decisions

- Per-client config, never hardcoded to MargenticOS. Synthesis reads client positioning at runtime.
- Tier 1 requires a specific dateable observation; Tier 3 is honest ICP pain framing, never fake personalization.
- Value prop alignment filter — signals about a prospect's clients (wrong audience) do not qualify for Tier 1.
- Parallelism at concurrency=5 (per-provider limits respected).
- LinkedIn via Apify (no account needed, $4–13/month at scale).
- Shared style module enforces no em dashes, no AI tells across all customer-facing agents.

## Tests verified clean April 24

- Ginny research result: Tier 3 classification with honest framing, no fallbacks triggered.
- All 5 pre-flight bug fixes committed and tested:
  - Bug 2A: `max_tokens` 1500→3000 (synthesis was hitting ceiling mid-reasoning)
  - Bug 2B: web search `limited` gate removed (thin-but-real results now reach synthesis)
  - Bug 2C: `buildTier3TriggerText()` grammar fixed (gerund/modal-negative/noun phrase detection)
  - Bug 8A: CSV FK disambiguation fixed (`prospects!prospect_id` to resolve ambiguous join)
  - Bug 6: `HAIKU_PERSONALIZATION_USD` added to cost estimate (was running 12–25% low)
- 36 commits pushed to main.

## Not yet tested on real data

- Tier 1 composition path (bridge generation + CTA)
- Parallelism at >5 prospects
- Full dogfood batch with diverse prospects

## Dogfood batch 1 prepped

- 11 real founder-led consulting firm prospects compiled in `dogfood-prospects-batch-1.csv` (project root)
- Pending Doug review and DB seeding

---

## Copy-quality rubric added (2026-08-19)

### What changed and why

The six tests (SPECIFIC, VERIFIABLE, INFERENTIAL, RELEVANT, USEFUL, NON_JUDGEMENTAL) all ask
whether an observation is TRUE and RELEVANT. None asked whether it was READABLE. This trigger
scored 6 out of 6 and shipped:

> "Running Taffet alongside the CRC Director engagement from mid-2024 through mid-2025 is a
> particular kind of balancing act, and with that role now wrapped, the pipeline question for
> Taffet tends to land differently."

37 words in one sentence, two hedges, ending on an abstraction. The messaging document was NOT
the source: it scores 1.4 percent nominalisation across all 716 words. Every bad line traced
back to this agent, which writes the observation that fills the Email 1 P2 slot.

### Four changes

1. READABLE is now a seventh scored test in the prompt, with four questions (say it aloud,
   picture test, buyer vocabulary, any other email), a 25-word sentence cap, a no-hedging rule,
   and both real examples included verbatim and labelled: the failing one above and the
   benchmark from a campaign that replied at 7 percent.

2. `src/lib/style/readability.ts` measures it deterministically. Sentence length and hedge
   phrases HARD-GATE hook selection because both are unambiguous. Nominalisation density
   (reusing `src/lib/style/nominalisation.ts`) only ever adds demerits, because suffix matching
   cannot tell "attention" from "question" and a hard gate on a check with known false
   positives would reject good copy.

3. `src/lib/style/sentence-frames.ts` detects repeated sentence frames ACROSS a batch. The tic
   ("is a particular kind of balancing act" / "juggle") came from the prompt itself, which
   handed the model that exact frame as a worked GOOD example. That example is deleted and
   stock frames are banned outright. Detection masks names and numbers, then compares 5-gram
   skeletons, so a template is caught even when every noun is swapped.

4. Inference direction is a distinct gate, not a tightened test. Every candidate must state the
   opposite reading of its own evidence. Where both readings are plausible, the observation must
   be phrased compatibly with both, or it is demoted out of hook use.

### What happens on a failure

A demoted candidate does not vanish. It falls from Tier 1 to `mention_only`, so the fact still
surfaces and is still stored, it just does not fill the P2 slot. Composition falls back to ICP
pain framing, which is good copy. `compose-sequence.ts:756` gates the bridge path on
`signal_relevance === 'use_as_hook'`, so demotion is the lever that stops bad copy shipping.

Frame collisions are logged and reported in `ResearchBatchSummary.frame_collisions`. They do
not trigger an automatic rewrite: see BACKLOG.md.

### Verification, 2026-08-19

Re-ran all three dogfood prospects (org 0ed34697-0fa9-4f08-ac15-d3504ac45caf) on commit be1bcb6.

| Prospect | Winning trigger | Max sentence | Hedges | Frame collision |
|---|---|---|---|---|
| Robert | "You ran Taffet and the CRC Director role side by side for 13 months. That wrapped in August 2025." | 14 words | none | none |
| Udo | "Bröskamp, Schumpeter Ventures, and FineVest have all been running under your name at the same time since 2023. Most founders at that stage find Bröskamp's pipeline gets whatever bandwidth is left." | 18 words | none | none |
| Alma | "Full Bloom has been running since September 2023. You've held a full-time Stanford GSB role alongside it since January 2024." | 12 words | none | none |

The CRC concurrent-role fact still surfaces as Robert's c1 winner, as required: what changed is
how it is written, not what is found. The readability gate visibly fired on three candidates
(Robert c4 at 29 words, Udo c4 at 30 words, Alma c5 at 34 words), all demoted out of hook use.

Re-run harness: `src/lib/agents/rerun-three-prospects.ts`. It costs real API spend per run.


---

## Callable from the application (2026-08-20)

### What changed

The agent had one caller in the repository: `src/lib/agents/run-dogfood-batch-2.ts`,
hardcoded to organisation `74243c62` and eleven prospect ids. A search of `src/app` found
nothing. So the live 15-prospect batch was not reproducible from the repository, and a
client could not be onboarded without hand-running a script. Writing a throwaway script per
batch is also what cost 22 USD in redundant research on 2026-08-20.

Research is now started from `/dashboard/operator/sourcing-review`, or from
`scripts/run-research.ts`, both through one shared entry point:
`src/lib/operator/research-batch-entry.ts`. Full documentation is in `docs/agents.md` under
"Pipeline entry points". `run-dogfood-batch-2.ts` is deleted.

`rerun-three-prospects.ts` is still the re-run harness referenced above, and still costs real
API spend per run, but it no longer hardcodes the organisation or the prospect ids:

    npx tsx --env-file=.env.local src/lib/agents/rerun-three-prospects.ts \
      --org <uuid> --ids <uuid>,<uuid>,<uuid>

It calls the agent directly and therefore has NO overwrite guard. Do not point it at
prospects whose copy has already been sent.

### The thing to know before running any batch

`updateProspect` writes `personalisation_trigger` and `personalisation_question` on every
run. On a SEND verdict it replaces the stored opening with new wording. On a HOLD verdict it
writes NULL, deleting it. Of the 15 researched prospects in the client-zero organisation, 12
hold a trigger and 3 hold NULL, so the HOLD path is not rare.

The entry point refuses any batch containing a prospect that already holds a trigger, unless
the caller passes `allow_overwrite_trigger`. The dashboard cannot pass it and does not read
it from the request body. Only `scripts/run-research.ts --allow-overwrite-trigger` can.

### Reuse is not free

`use_stored_findings: true` skips all four sources and the Sonnet synthesis call, but the
writer, the floor check and the judge still run on `claude-sonnet-4-6`. Roughly 0.05 to 0.06
USD per prospect, measured across 156 reuse runs on 2026-08-20. Reuse also does not guarantee
that a prospect skips its sources: one with nothing usable on file falls back to a full
fetching run, which is why the entry point counts the real mix before admitting a batch.

### Verified 2026-08-20, on one prospect

The acceptance run on the 15 client-zero prospects was cancelled: a run would rewrite the
openings that are about to be sent. Verified instead on one prospect
(`63ea6c82`, `newperson@example.com`) in the DRY RUN TEST org, unarchived for the run and
reverted byte-for-byte afterwards.

| Check | Result |
|---|---|
| Selected | 1 of 1, the only live prospect |
| Duration | 29.2s against a 47s estimate |
| Result row | `c0f35d3a` written, 4 sources attempted, 0 successful |
| Prospect update | `current_research_result_id` points at the new row, `research_ran_at` and `classified_at` stamped, `trigger_data` written |
| Judge | HOLD, so `personalisation_trigger` and `personalisation_question` are both NULL |
| Other prospects | zero rows written |
| Cost | 0.03 USD |

The HOLD is the correct outcome. The fixture has no name, no company and a fake email, so
synthesis returned zero candidates and the writer had nothing to work with. Composition would
fall back to the variant's authored opener, which is approved copy.

Not proven by this run: the browser-to-route hop. The routes' auth gate is verified separately
(403 without a session), and the route calls the same shared entry point, so what remains
untested is the route's JSON body parsing.

---

## Prompt caching (2026-08-25)

**What changed.** Both large system prompts now cache. Neither could before, because
caching is a PREFIX match and each had a variable near the top:

| Prompt | Was varying on | Moved to | Measured size |
|---|---|---|---|
| Synthesis | `signalBlock` (the per-prospect recency check), at ~line 62 of 471 | user message, under `## Recency check` | **6,953 tokens** |
| Writer | `clientName` (line 1), `p3` (line 22), `cta` (line 63) | user message, in the `## Assignment` block above the findings | **8,738 tokens** |

The synthesis system prompt is now per-CLIENT only, and a batch runs one client at a time,
so it is byte-identical across every prospect in a run. The writer system prompt is now a
CONSTANT, identical for every prospect, variant and client.

**Floor and judge are deliberately NOT cached.** They are ~124 tokens each, far below
Anthropic's ~1,024-token minimum cacheable prefix. A breakpoint on them would be silently
ignored while still consuming one of the four a request is allowed.

**Where it pays most: the retry path.** The writer call runs up to three times per prospect
(`maxAttempts = strongMaterial ? 3 : 2`), and each attempt previously re-sent the whole
8,738-token prompt at full price. Roughly 93% of that call's input is static.

**The receipt, measured live 2026-08-25:**

```
  prospect 1 | synthesis  input 123  cache_read 6953
  prospect 1 | writer     input 143  cache_read 8738
  prospect 2 | synthesis  input 123  cache_read 6953
  prospect 2 | writer     input 143  cache_read 8738
```

`input_tokens` collapses to the per-prospect message alone. Reproduce with:

```
RUN_CACHE_PROBE=1 npx vitest run src/lib/agents/research/__tests__/cache-receipt.test.ts
```

That test is skipped unless `RUN_CACHE_PROBE` is set, because it makes real paid calls. It
does NOT run the research agent, deliberately: that would fetch paid sources and overwrite
`prospect_research_results` for a prospect whose copy may already have shipped.

**If it silently stops working.** Caching fails without erroring: one per-prospect byte back
in a system prompt and every call reverts to full input price with nothing going red. Two
guards exist. `write-opening.ts` logs `cache_read_input_tokens` on every model call at debug
level, and `write-opening.test.ts` asserts the writer system prompt is a constant. Run the
receipt above after any edit to either prompt builder.

**What did NOT change:** no validator, no word limit, no style rule. The three writer values
were relocated, not rewritten, and `checkOpeningGates` still receives `params.p3` exactly as
before. The instruction to read the offer line before the findings still holds, because the
assignment block physically precedes the findings in the user message.

---

## Baseline run, 2026-08-25 — first real batch through the queue

Thirteen fresh MargenticOS prospects, `queue_research` on, current code. Asked for twenty;
thirteen is every prospect the enqueue guard will accept in the live org (29 total, 15
already researched, 12 of those holding shipped copy, 1 suppressed).

**Write rate: 12 of 13 = 92.3% `use_as_hook`.** Against the 88.5% post-2026-08-20 baseline,
so moving `p3`, `cta` and `clientName` out of the writer system prompt shows NO regression.
That was the open question from the caching change and it is now answered on real data.
`signal_relevance` and the job's `result_summary` agreed on all 13 rows.

**Prompt caching took on a real batch**, which the probe alone could not prove:

| | tokens |
|---|---|
| read from cache | 222,234 |
| written to cache | 49,430 |

`cache_read` is non-zero on all twelve prospects after the first. Synthesis prompt is 6,782
tokens, writer 8,738; a prospect that retries the writer reads 8,738 twice. Three prospects
(2, 3 and 6) also WROTE, because they started before the first entry committed. Concurrent
fan-out costs a few 1.25x writes at the head of a batch and then self-corrects.

**Measured cost, 13 prospects, all in:**

| line | $ | $/prospect | share |
|---|---|---|---|
| output tokens | 1.5922 | 0.1225 | 62% |
| web search tool | 0.5400 | 0.0415 | 21% |
| cache write | 0.1854 | 0.0143 | 7% |
| input (uncached) | 0.1460 | 0.0112 | 6% |
| cache read | 0.0667 | 0.0051 | 3% |
| Apify posts actor | 0.0260 | 0.0020 | 1% |
| **TOTAL** | **2.5562** | **0.1966** | |

Same run with caching off would have been $3.1192. **Caching saved 18%**, not the ~50% the
pre-run estimate implied, because OUTPUT dominates and caching only touches input.

60 Anthropic calls over 13 prospects = 4.6 per prospect. 54 web searches = 4.15 per
prospect, so the new `WEB_SEARCH_MAX_USES` cap of 3 per query is occasionally binding.
Duration ran 130s to 321s per prospect.

**The one failure is the interesting row.** It was a synthesis FALLBACK: zero candidates,
low confidence, `relevance_reason` "Synthesis fallback: no trigger written, ICP pain proxy
recorded" — and **15,096 output tokens against the 16,000 `max_tokens` ceiling**. The
reasoning block has grown back to the point where it approaches the ceiling that was raised
from 8,000 on 2026-08-19 for exactly this reason. Lowering `max_tokens` would make this
MORE frequent, not less. The lever is the reasoning block in `synthesis-prompt.ts`, which
is eight numbered sections several of which run per candidate, and which is 100% billable
visible output: extended thinking is not enabled on any of the four calls.

**The unverified number in the cost model** is `COST_WEB_SEARCH_PER_SEARCH = $0.01`, taken
from Anthropic's published ~$10/1,000 rate rather than measured from an invoice. The search
COUNT is now measured; the price per search is not. Everything else above is derived from
`usage` fields returned by the API.

## The fit judge is shown the company (2026-09-11)

### What was wrong

The synthesis call grades `icp_fit`: does this prospect's COMPANY fit the client. Measured on
one client's 111 researched prospects, the judge's material held a staff count for 17 and a
company description for 15, while staff count and industry sat in their own columns on all 111.
So company fit was being graded from a website excerpt and a web search.

The cause was a seam. Enrichment writes staff count and industry to
`prospects.company_headcount` and `prospects.company_industry`, and keeps an allow-listed
organisation subset in `apollo_enrichment_data`. The judge's "Apollo Enrichment" section is
formatted from that subset, which deliberately carries neither figure. The lines for them only
ever appeared for prospects researched through the older live lookup.

### What changed

A `## Company on file` section now sits between `## Prospect` and `## Recency check` in the
judge's message. It carries staff count, industry, the other industries the record lists, year
founded, recorded revenue (when not zero), the first 25 keywords, and the website. It opens with
a line telling the model these are for judging fit and are never email copy.

Everything in it was already bought at enrichment. **No new lookup and no new call.**

- `src/lib/agents/research/company-facts.ts` — the mapping from the prospect row and the
  formatter. Its header lists what is deliberately left out and why: there is no description on
  file (the allow-list keeps none), growth is already in the Apollo section, country is the
  person's, codes duplicate the industries.
- `ProspectContext.company` is REQUIRED, not optional. The batch path builds its own context
  (`contextFor` in `batch-sweep.ts`), and an optional field would have let it silently omit the
  facts while the inline path sent them. Required means the compiler stops any new builder.
- The loader (`prospect-context.ts`) and the batch sweep's prospects join both select the four
  columns the mapping reads.
- A prospect with nothing on file gets the same request bytes as before the section existed.

### If it breaks

The test is `src/lib/agents/research/__tests__/judge-company-evidence.test.ts`: one case per
fact, and a loader case whose fake returns only the columns the select named. If a fact stops
reaching the judge, the case named after that fact fails.

### What the fuller evidence did, measured 2026-09-11

Twenty already-graded prospects, chosen by a fixed rule before any grading (every 111/20th by
id), were re-graded twice on the same day through the production request builder: once with
the evidence as it was, once with the company section. Nothing was written to any table. On all
20, the two requests differed by the company section and nothing else.

| | moderate | strong | weak |
|---|---|---|---|
| stored grade | 16 | 2 | 2 |
| re-graded, evidence as it was | 19 | 0 | 1 |
| re-graded, with company facts | 15 | 3 | 2 |

- Changed from the stored grade: 4 of 20 on the old evidence, 6 of 20 with the company facts.
- The company facts changed the verdict against the old evidence, same day, on 4 of 20.
- **The same judge on identical evidence disagreed with itself on 4 of 7.** The first
  company-facts run died after 7 calls and was repeated, so those 7 were graded twice on the
  same input. A 4-in-20 difference is inside that, so this sample cannot show the facts moved
  any verdict.
- Most grades still sit on the middle value: 15 of 20 with the facts, 19 of 20 without.

At the time the request set no temperature, so the judge sampled at the API default of 1.0,
the likeliest source of the 4-in-7 self-disagreement. Fixed next; see below.

Cost: $4.20 of a $5 cap, including $0.75 for the run that died.

## The fit judge stops sampling and is told the job title (2026-09-11)

Two fixes to the same synthesis request, both in `buildSynthesisParams`, so the live and batch
paths get them together:

- **`temperature: 0`**, for this call only. Its product is a verdict. The writer is untouched
  and stays unpinned on purpose (see the comment above its `messages.create`).
- **The Role line reads `job_title`**, falling back to `role`. It read `prospects.role`, which only
  the old research agent wrote: empty on all 111 researched prospects, so every request said
  "Role: Unknown". `buildIcpPainTrigger` still reads `role`; it builds fallback COPY, so it is
  left for the copy work (Backlog row).

Tests: `src/lib/agents/research/__tests__/judge-settings.test.ts`, plus the loader and batch-path
cases. Each fix was removed in turn and a test went red (2 mutations and 7 mutations).

### Does it settle? Measured 2026-09-11

The same 20 prospects, graded twice with both fixes in. Every request sent temperature 0, none
said "Role: Unknown", and the whole-request fingerprint matched between the two runs on all 20,
so the input was identical.

| | before (temperature 1.0) | after, run 1 | after, run 2 |
|---|---|---|---|
| disagrees with itself | 4 of 7 | 2 of 20, both runs | |
| moderate / strong / weak | 15 / 3 / 2 | 17 / 1 / 2 | 17 / 1 / 2 |
| differs from stored grade | 6 of 20 | 6 of 20 | 4 of 20 |

- **Self-disagreement fell from 4 in 7 to 2 in 20, and did not reach zero.** Both remaining flips
  are one prospect moving between strong and moderate on byte-identical input.
- **The middle value got MORE crowded, not less:** 17 of 20.
- So the settings are no longer the main problem. What is left sits on the line between strong
  and moderate, and the definitions make moderate the default for anything uncertain ("evidence
  too thin to grade STRONG", "grade cautiously when sparse", "if you find yourself reaching for a
  criterion, grade MODERATE"). **The definitions are the next piece of work.**

Cost of this measurement: $3.30 of a $5 cap.

## The fit judge grades the prospect, and "cannot tell" is its own outcome (2026-09-11)

### What changed

`moderate` meant both a genuine partial fit and "I cannot tell". The prompt sent thin evidence,
sparse profiles and uncertain criteria there, and the code stored a failed or unreadable answer
there too.

- **A fourth outcome, `cannot_tell`**, is never a grade and never a fit (`ICP_FIT_OUTCOMES` against
  `ICP_FIT_GRADES` in `types.ts`). A failed call, an answer with no text, an answer that is not
  JSON, an `icp_fit` outside the four outcomes, and a reused research row with no grade all record
  it, with `icp_fit_missing` saying why. They all used to record `moderate`.
- **The definitions judge the prospect.** STRONG matches every dimension the client context names;
  MODERATE clearly meets some and clearly misses at least one; WEAK is unchanged; CANNOT_TELL names
  what the research could not check. An unknown dimension is unknown, not a partial match. The
  three sentences that sent uncertainty to MODERATE are gone.
- **The database CHECK on `icp_fit`** must be widened for the new value. Migration
  `20260911150000_icp_fit_cannot_tell.sql` is written and **not applied**: it drops and re-adds the
  constraint, which needs an explicit yes. It must be applied to production and the test project
  before this branch is merged, or research writes that reach no grade will fail the CHECK.

Tests: `judge-definitions.test.ts` (outcomes, failed and unreadable answers, the prompt, the
migration), plus the reuse case in `stored-findings.test.ts`. Nine mutations, each red.

### What it did, measured on the same 20 prospects, twice

Temperature 0, job title and company facts in every request. 19 of 20 requests were
byte-identical between the two runs; the 20th had an identical prospect message and the same
verdict both times.

| | before (old definitions) | run 1 | run 2 |
|---|---|---|---|
| strong / moderate / weak / cannot_tell | 1 / 17 / 2 / 0 | 1 / 6 / 1 / 12 | 0 / 7 / 2 / 11 |
| disagrees with itself | 2 of 20 | 4 of 20 (4 of 19 on byte-identical input) | |

- **The middle value emptied into cannot_tell.** Of the 17 prospects graded moderate before, 11
  are now cannot_tell and 6 are still moderate.
- **Every cannot_tell names revenue as what is missing**: 12 of 12 in run 1, 11 of 11 in run 2.
  About half also name average deal size or operating history. Those are disqualifiers in this
  client's own ICP, and the research does not collect them: revenue is on file for 12 of the 111
  researched prospects.
- **Self-disagreement rose from 2 to 4 of 20**, and 3 of the 4 are one run saying cannot_tell
  where the other gave a grade. The line between "an unknown could move the grade" and "what is
  known decides it" is where the judge now wobbles.

So this is mostly not a wording problem. The judge cannot grade these prospects because the
evidence that would decide them, revenue above all, is not in what the pipeline gathers.

Cost of this measurement: $3.71 of a $6 cap.

## What the fit judge is asked to establish (2026-09-11)

### Why

A client's profile can name facts no research source can establish. The live client's names
one as a hard disqualifier, and every cannot_tell in the run above named it. The decision
recorded in August was to stop qualifying on that fact at the sourcing stage and settle it on
the discovery call instead; the judge had never been told.

### What changed

- **Unestablished facts are listed, not graded on.** The prompt's "can and cannot establish"
  block tells the judge that a fact no source reads (the usual case is a private business's
  private financial figures and commercial terms) goes in `icp_fit_unestablished` and is left out
  of the outcome. It is never the reason for CANNOT_TELL or WEAK. CANNOT_TELL is now only for a
  dimension the research COULD have shown and did not.
- **Three checks, from evidence already gathered.** `fit_checks` records, from the employment
  history and the website, yes / no / unknown with one sentence of evidence for:
  - `primary_occupation`: the role is the person's main occupation;
  - `runs_the_business`: they run the business day to day rather than hold a title in it;
  - `reachable_by_channel`: the people the business sells to can be reached through the channel
    the client's own documents describe (`not_applicable` when they describe none).
  Each is graded as a dimension of fit: a clear no is a clear miss. No new source and no new call.
- Neither list is stored in its own column yet. Both are in the synthesis output and the stored
  reasoning.

Tests: `judge-checks.test.ts`. Each check was removed in turn and a test went red.

### Measured on the same 20 prospects, twice

Temperature 0, job title and company facts in every request, and the input byte-identical
between the two runs on all 20.

| | before this change | run 1 | run 2 |
|---|---|---|---|
| strong / moderate / weak / cannot_tell | 1 / 6 / 1 / 12 | 4 / 10 / 2 / 4 | 3 / 10 / 2 / 5 |
| disagrees with itself | 4 of 20 | 8 of 20 | |

- **cannot_tell fell from 12 to 4 and 5.** Of the 12 that were cannot_tell before, 7 are now
  moderate, 1 strong, 1 weak and 3 still cannot_tell.
- **The cannot_tells left are prospects with no evidence at all.** Five of the 20 sampled have a
  current research row that is a reuse row which fetched no sources, so the judge saw only the
  header and the company facts. That is the correct answer for them.
- **Every prospect had at least one fact recorded as unestablished**: average deal size (13 of
  20), revenue (7), and whether the client's buyer would approve each email personally (about 9).
  All are criteria in the live client's own profile that no source this research reads can show.
- **Self-disagreement doubled, to 8 of 20**, on byte-identical input at temperature 0: three flips
  between moderate and strong, five between moderate and cannot_tell. With the unobtainable facts
  out of the outcome, the grade now rests on judgement calls at those two boundaries, and the
  judge lands on either side of them from one run to the next.

**The three checks, how many of the 20 fail each** (result "no"), which nothing had measured:

| check | run 1 | run 2 | same result in both runs |
|---|---|---|---|
| primary_occupation | 3 no, 7 unknown | 2 no, 8 unknown | 17 of 20 |
| runs_the_business | 1 no, 4 unknown | 1 no, 5 unknown | 15 of 20 |
| reachable_by_channel | 2 no, 3 unknown | 0 no, 3 unknown | 17 of 20 |

Five of the 20 failed at least one check in run 1 and two in run 2. The two that failed in both
runs are a person holding several concurrent roles who is not the one running the business
(graded weak both times), and a person with a concurrent full-time position elsewhere. Four of
the five had already been uploaded for sending. Most unknowns are the five prospects with no
evidence.

Cost: $4.60 of a $6 cap.

### The staff-count ceiling, measured and NOT changed

Free people-search counts for the live client's stored spec (the search is free; controls: an
impossible range returned 0 and no range returned 635,364, so the parameter is read):

| ceiling | people reachable | change |
|---|---|---|
| 20 (today) | 98,814 | |
| 25 | 115,605 | +17.0% |
| 30 | 128,750 | +30.3% |

The 21 to 30 band alone is 29,936 people, exactly the difference.

## Which research record the grader reads (2026-09-11)

### The defect

A reuse run writes a research record that fetches nothing and makes it the prospect's current
one. On 2026-08-20 one batch did that to twelve prospects for the live client, all later
uploaded; their full records, written about seven hours earlier, were still on file. Anything
judging from the current record judged from nothing. Reuse itself then preferred the newest
reuse record over the full one, because on every other sort key the two tie.

### What changed

- `evidence-record.ts`: `loadEvidenceRecord` returns the newest record, in the prospect's own
  organisation, with at least one successful source. `current_research_result_id` is untouched:
  it still records which run last touched the prospect.
- `grade-from-evidence.ts`: grades a prospect from that record. It fetches nothing and writes
  nothing; `readProspectContext` reads the prospect without stamping a segment. Recording a
  grade it reaches is a separate decision nothing takes yet.
- `loadStoredFindings`: holding evidence is now the first sort key.
- `scripts/grade-from-evidence.ts`: operator CLI with a hard spend ceiling. It saves after every
  prospect and waits 600s per call, as production does. The first version waited 240s and saved
  only at the end, and lost six paid grades when its seventh call timed out.

Tests: `evidence-record.test.ts`, `stored-findings.test.ts`. Seven mutations, all red.

### The twelve, graded from their full records (measured 2026-09-11)

| prospect | stored grade | from the full record | main occupation / runs it / reach |
|---|---|---|---|
| ca26acfd | moderate | strong | yes / yes / yes |
| ee42ed11 | moderate | strong | yes / yes / yes |
| 08873b1d | moderate | moderate | yes / yes / yes |
| 6462fb0f | moderate | weak | yes / yes / yes |
| 42e90653 | moderate | moderate | yes / yes / no |
| ce9c94af | moderate | moderate | yes / yes / yes |
| 8bd0578a | moderate | moderate | yes / yes / yes |
| f5f83c7a | weak | weak | no / yes / no |
| ecc5f9d2 | moderate | no grade: the answer ran past 16,000 output tokens and was cut off | |
| f69dedaa, 1c0b56bb, a547b044 | strong, moderate, moderate | not graded, to protect the spend cap | |

The full record for ecc5f9d2 makes the judge's answer longer than its output ceiling, so the JSON
is lost and no grade is reached. Research run on that record would hit the same limit.

Spend: $0.62 metered, plus a first, unmetered run of six grades in which one prospect timed out
four times. Estimated $1.6 to $2.0 in all; about $3.10 if every timed-out attempt was billed.

## The judge reads each dimension, and code gives the grade (2026-09-11)

### Why

At temperature 0 on byte-identical input the judge disagreed with itself on 8 of 20 prospects,
and in 3 of those its three checks were identical both times. The reading was stable; the final
word was not. It was also re-deciding on every call which conditions the profile names and which
of them research can establish, which is a property of the profile, not of the prospect.

### What changed

See ADR-057 for the decision and the rules. In short: the conditions are derived once when the
ICP is approved and stored on the spec (`fit_dimensions`); the judge records match, miss, unknown
or unestablished for each, with a verbatim quotation, and is asked for no grade; code computes
the grade. A quotation not found in the exact user message the judge was sent counts as unknown.
A client with no stored list gets a byte-identical request and the judge's own grade, checked by
fingerprinting the request before and after the change.

Tests: `fit-dimensions.test.ts`, `fit-dimensions-agent.test.ts`, `judge-dimensions.test.ts`,
`persist-fit-dimensions.test.ts`. Twenty mutations, all red.

### The live client's list, derived in memory (not stored: re-approval was not authorised)

Ten dimensions from 25 statements: 9 required, 8 establishable. Industry, location, staff count,
the buyer's title, founder-led, sells to businesses, operating history and credibility proof are
marked establishable. The revenue floor and the minimum deal size are marked as research usually
cannot establish, which matches what the earlier runs found: every prospect had them missing.

### Measured on the sample, twice (2026-09-11)

The spend cap allowed 15 of the 20 in each run at $0.171 a call, and the second run was restricted
to exactly the 15 the first graded. The request was identical between runs for all 15.

| | earlier pair, same 15 | run 1 | run 2 |
|---|---|---|---|
| strong / moderate / weak / cannot_tell | 4 / 6 / 2 / 3 | 1 / 2 / 8 / 4 | 2 / 2 / 7 / 4 |
| disagrees with itself | 6 of 15 | 2 of 15 | |

- **Both remaining disagreements are one failure, not judgement.** In each case one of the two
  runs hit the 16,000-token output ceiling, lost its JSON and recorded cannot_tell. On the 13
  prospects where both runs produced readings, the grade agreed 13 of 13.
- **The readings themselves are nearly fixed.** Of 130 dimension readings compared across the two
  runs, 5 differed: `buyer_title` twice, `sells_to_businesses` twice, `founder_led` once.
- **The judge never volunteered a grade**, in 30 of 30 calls.
- **8 of 300 readings claimed a match or a miss with a quotation that was not in the material**
  and were counted as unknown. They cluster on the same three dimensions.
- **The grade moved hard towards weak**: 8 of 15 against 2 of 15 before. The rules are stricter
  than the judge's own summary judgement was. The misses are real and quoted: staff count outside
  the band (3), a buyer title the profile does not name (3), a location outside the three
  countries (2).

### Three things the measurement exposed, none of them fixed here

1. **The 16,000-token ceiling truncates real answers.** 2 of these 30 calls, plus one of the
   twelve in the section above. A truncated answer reaches no grade at all.
2. **The judge is never shown the country**, though `prospects.country` is filled for all 111
   researched prospects. `company_geography` therefore read unknown for 6 of 13 and is what most
   cannot_tell verdicts rest on.
3. **`buyer_title` is as literal as the profile.** It names two titles, so a founder whose title
   reads differently is a quoted miss, and one miss on a required dimension is weak.

Spend: $5.13 for 30 grading calls, plus one derivation call of about $0.03 to $0.10.

## The three things that measurement exposed, fixed (2026-09-12)

### The country we already hold is shown to the judge

`prospects.country` is ISO-3166 alpha-2 and filled for all 111 researched prospects of the live
client. It was never sent, so the judge looked for location in the research and read it as unknown
for 6 of 13 prospects, which is most of what put them in cannot_tell.

The prospect header now carries `Country: <code> (recorded when this prospect was sourced)`, which
says what it is: a record of where sourcing found them, not a finding of this research. The batch
path reads the same column through its own join, so neither path grades location blind while the
other does. Verified free on three real prospects by building their requests without calling the
model.

### A condition that names titles is read as a position, not as wording

A profile lists example titles for the buyer. The derived condition asked for those titles, so a
person holding the same position under different wording was a quoted miss, and one miss on a
required condition is weak: 3 of 15 were marked that way.

The derivation is now told that named titles are examples of a position, and to write the
condition as whether the person holds an equivalent position, saying what it is accountable for,
runs or decides. The judge is told the same when it reads such a condition. On the live client's
profile the literal title condition disappeared: the re-derived list asks whether the buyer holds
an equivalent position to the ones the profile names, described by what they do, and it split out
a separate condition about there being no functioning internal sales team.

### A cut-off answer is a failure with its own reason

The JSON is the last thing the judge writes, so an answer that reaches the ceiling always loses it.
The ceiling is 24,000 rather than 16,000, which costs nothing on answers that do not need it
because output tokens are billed as generated. A cut-off answer now returns without parsing what
arrived, and records the ceiling and the tokens it ran to in `icp_fit_missing` and in
`relevance_reason`, which is the field stored on the research row. It used to record "Claude
returned non-JSON", blaming the model for something we did.

Tests: `judge-location.test.ts`, `judge-truncation.test.ts`, plus assertions in
`judge-dimensions.test.ts`, `fit-dimensions-agent.test.ts` and `batch-sweep.test.ts`. Eleven
mutations, all red.

### Measured on 8 of the 15, ONCE, and then the account ran out of API budget

The re-grade was meant to be the same 15 twice. The first run graded 8, then two calls timed out
and five came back `invalid_request_error: You have reached your specified API usage limits. You
will regain access on 2026-10-01 at 00:00 UTC.` The second run reached nothing at all. So the
numbers below are one reading of 8 prospects, and **self-disagreement was not re-measured**: the
2-of-15 figure from the pre-fix pair still stands as the last measurement of it.

Spend: $1.26 of a $6 cap, plus one derivation call. A refused call is not billed; the two timeouts
may have been.

| | the same 8, before these fixes | after |
|---|---|---|
| strong / moderate / weak / cannot_tell | 1 / 2 / 4 / 1 | 0 / 0 / 3 / 5 |

- **Location is settled.** `company_geography` read match 7, miss 1, unknown 0. On the same 8
  before, it read unknown 3 times. The one miss is a company outside the three countries the
  profile names, which is the right answer.
- **The literal title misses are gone.** The condition now asks whether the buyer holds an
  equivalent position. It read match 7 and miss 1, and that miss is a person whose position is
  genuinely not the one described, which the person checks flag too.
- **No answer was truncated**, against 3 of 39 before.
- **Weak fell from 4 of 8 to 3 of 8**, and each remaining weak is a quoted miss on a required
  condition: one revenue floor, one location, one position.
- **A NEW unknowable condition replaced the old problem.** The re-derived list contains
  "the firm does not have a functioning internal sales team with a dedicated pipeline owner",
  marked as something research can establish. It read **unknown on 8 of 8**, and because it is
  required, it is the sole reason all five non-weak prospects are cannot_tell. This is the failure
  mode already written up under the fit dimensions agent: a required condition marked establishable
  that the research does not, in practice, show. It is not fixed here.
