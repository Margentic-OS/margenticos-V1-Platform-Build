// Pricing constants for prospect research cost estimation.
// Used by both the batch runner (prospect-research-agent-v2.ts) and the standalone estimate CLI.
// Update here when model pricing changes — one place, both consumers stay in sync.

// Sonnet 4.6, the four research calls per prospect (synthesis, writer, floor judge, judge).
//
// MEASURED, NOT DERIVED. The console billed $2.07 of Sonnet over 13 prospects on
// 2026-08-25, which is $0.159/prospect. The previous bounds of $0.015-$0.025 came from a
// token-count estimate and were roughly 8x low, because they priced ONE call rather than
// four and took no account of the retry path, which re-runs the writer.
//
// The range spans the retry path: a clean prospect makes four calls, a retried one makes
// five or six.
export const COST_ANTHROPIC_LOW  = 0.130
export const COST_ANTHROPIC_HIGH = 0.190
export const COST_ANTHROPIC_MEASURED = 0.159

// Apify, per prospect. ONE actor since 2026-08-25: harvestapi~linkedin-profile-posts.
// The profile scraper was dropped after producing 1 candidate in 147, never selected.
//
// ═══ CORRECTED 2026-09-23, FROM $0.002. THE OLD FIGURE WAS 20x LOW ═══════════
//
// It read $0.002 and cited "$2/1000", which was the PRICE_PER_DATASET_ITEM model. The
// actor moved to PAY_PER_EVENT on 2026-03-09 and the repo never noticed, because nothing
// reads a vendor's pricing page on a schedule and the constant looked like a fact.
//
// Under pay-per-event:
//     actor start        $0.00005   once per run
//     each post returned $0.002     the primary charged event
//     zero-result query  $0.001
//
// MEASURED against the live Apify API on 2026-09-23, over the 158 successful runs of
// 2026-09-21: mean $0.0795 a prospect, median $0.098, and 77 of 158 at exactly $0.10005.
// That $0.10005 is one start plus FIFTY posts, because maxPosts was unset. The formatter
// read five of them.
//
// THIS FIGURE IS THE CEILING UNDER THE NEW SETTINGS, not the old measurement:
//     0.00005 + (MAX_POSTS 5 x 0.002) = 0.01005
//
// A ceiling rather than a mean, deliberately. A prospect who posted less returns fewer
// items and costs less, so this over-estimates and never under-estimates, which is the
// direction a spend guard has to err. The old figure erred the other way for six months.
//
// IF MAX_POSTS CHANGES IN linkedin.ts, CHANGE THIS. They are two numbers that must agree
// and there is no way to derive one from the other across the module boundary without
// importing the source handler into the cost model, which is worse. A test pins them.
export const COST_APIFY = 0.01005

// Brave Search: 2 calls per prospect; free tier covers 2000 calls/month
export const BRAVE_FREE_MONTHLY  = 2000
export const BRAVE_PAID_PER_CALL = 0.003

// ─── Anthropic native web search ─────────────────────────────────────────────
//
// MEASURED AGAINST THE ANTHROPIC CONSOLE, 2026-08-25. Console figures supplied by Doug,
// filtered to that day alone; the attribution below was confirmed independently from the
// repo and the database. THE CONSOLE IS THE GROUND TRUTH against which any future estimate
// in this file is checked. Nothing here is a published-rate guess any more.
//
//   Total cost          $3.15
//   Token cost          $2.61   ($2.07 Sonnet + $0.55 Haiku)
//   Web search fee      $0.54
//   Prospects in run    13
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE GOT WRONG: THE SEARCH WAS PRICED AS A FEE WITH NO TOKENS
//
// The previous version of this block priced the native path as ~$10/1,000 searches and
// waved the Haiku tokens through at "roughly $0.003-$0.005 per prospect ... folded into
// the range below". That was the error, and it was an order of magnitude.
//
// fetchWebSearchSource fires two queries per prospect, and EACH IS A FULL HAIKU REQUEST
// carrying the server-side web_search tool (tools/webSearch.ts:113). Anthropic bills the
// tool per search AND bills the request's tokens like any other call. Search results are
// injected into the context, so the input side is not the "one short prompt" the old
// comment assumed.
//
// Measured: $0.55 of Haiku over 13 prospects is $0.042/prospect, against the $0.003-$0.005
// estimated. The FEE half was fine; the TOKEN half was ~10x low.
//
// THE ATTRIBUTION OF ALL $0.55 TO WEB SEARCH IS SOUND, verified by elimination rather than
// assumed. Five things in this repo call Haiku. On 2026-08-25 the database records 0 FAQ
// extractions, 0 reply drafts and 0 reply-handling actions; the v1 prospect research agent
// is imported by nothing outside test fixtures; and composition's only Haiku call is the
// bridge sentence, disabled since 5047e24 (2026-08-19). Web search was the sole Haiku
// consumer that day.
//
// AND THE PER-SEARCH PRICE IS NOW CONFIRMED. BACKLOG.md flagged $0.01/search as the one
// unverified number in the cost model. The run made 54 searches (raw_web_search.search_count,
// 4.15 per prospect) and the console billed $0.54. 54 x $0.01 = $0.54 exactly. It reconciles.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS MATTERS BEYOND ACCOUNTING
//
// Web search WAS $1.09 of $3.15, or 35% of Anthropic cost per prospect: the second-largest
// line after Sonnet. Every earlier argument about it was conducted at roughly 21%.
//
// That number triggered the 2026-08-25 reduction to one query capped at one search, which
// was forecast to take it to roughly 16% and the all-in per-prospect figure from $0.245 to
// $0.192.
//
// ─── $0.192 NEVER HAPPENED. CORRECTED 2026-09-14. ────────────────────────────
//
// It rested on one search per prospect. Measured over 73 production prospects the figure
// is 2.83 (WEB_SEARCH_SEARCHES_PER_PROSPECT), so web search is $0.053 rather than $0.031
// and the all-in research-scope figure is about $0.214, not $0.192.
//
// AND THE SONNET LINE HAS MOVED TOO, in the same direction and by more. Synthesis output
// measured 11,796 and 11,612 tokens on the first live batch (2026-09-14) against the 7,750
// recorded on 2026-08-25: up roughly 51%. Synthesis alone, at standard price with caching,
// is now about $0.18 per prospect, which is more than the whole four-call $0.159 figure
// this file still carries as COST_ANTHROPIC_MEASURED.
//
// COST_ANTHROPIC_* IS THEREFORE STALE AND IS DELIBERATELY NOT CHANGED HERE. It is a
// console-reconciled number and the replacement would be derived from returned usage on
// two prospects, which is a weaker kind of evidence, not a stronger one. Re-reconcile a
// console day before overwriting it. What is recorded here is that it is known low.
//
// THE FIGURES IN THIS FILE ARE A MIX OF MEASURED AND ESTIMATED AND THE LABELS MATTER:
//   COST_WEB_SEARCH_PER_SEARCH   MEASURED, console, reconciles exactly
//   WEB_SEARCH_SEARCHES_PER_...  MEASURED, 73 production prospects
//   COST_WEB_SEARCH_HAIKU_TOKENS ESTIMATE, bounded $0.021 to $0.029
//   COST_ANTHROPIC_MEASURED      MEASURED on 2026-08-25, KNOWN LOW since 2026-09-14

/** Per search, confirmed against the console 2026-08-25: 54 searches billed $0.54. */
export const COST_WEB_SEARCH_PER_SEARCH = 0.01

// ═════════════════════════════════════════════════════════════════════════════
// THE SHAPE CHANGED ON 2026-08-25: 2 QUERIES x UP TO 3 SEARCHES -> 1 QUERY x 1 SEARCH
//
// Everything below the line is an ESTIMATE of the new shape, derived from the measured
// old one. The measured figures for the OLD shape are kept alongside, because they are
// the only numbers here that came off an invoice and they are what the new run gets
// checked against.
//
// Why it changed: web search was 35% of Anthropic cost per prospect and won 0 of 11 clean
// shipped openings. It was REDUCED rather than deleted because it is the only source
// covering what the outside world says about a prospect. See
// src/lib/agents/research/sources/web-search.ts for the full argument.

/**
 * Queries fired per prospect. ONE since 2026-08-25.
 *
 * A MIRROR, NOT A CONTROL. The real count is structural: it is however many webSearch
 * calls sources/web-search.ts makes. Nothing enforces that these agree, and before the
 * reduction this constant read 2 while the call site fired 2 by having two lines. If the
 * call site changes, change this too.
 */
export const WEB_SEARCH_QUERIES_PER_PROSPECT = 1

/**
 * Searches per prospect. MEASURED 2.83 over 73 production prospects. n IS PART OF THE FIGURE.
 *
 * ─── THE CLAIM THAT WAS WRONG, AND WHY IT READ AS SAFE ───────────────────────
 *
 * This constant first read 1 and its comment said "the first figure here that is a hard
 * bound rather than an average", on the reasoning that the per-prospect caller passes
 * { maxUses: 1 } and one query cannot exceed its own cap.
 *
 * THE CAP IS NOT HONOURED AS A BILLABLE BOUND. The parameter is passed correctly into the
 * tool definition (tools/webSearch.ts) and the counting is correct — searchCount counts
 * web_search_tool_result blocks, and one block is one charged search. The provider simply
 * runs more searches than the cap and bills for them.
 *
 * So the reasoning was sound and its premise was false, which is the worst combination:
 * nothing about the code looked wrong.
 *
 * ─── AND THEN THE CORRECTION WAS ITSELF UNDER-SAMPLED ────────────────────────
 *
 * The first correction put this at 1.67, from 15 billable searches over NINE capped
 * lookups on 2026-09-08. Nine is small enough that two quiet lookups move it a long way,
 * and they had.
 *
 * READ BACK FROM prospect_research_results ON 2026-09-14, every row carrying a
 * search_count under the one-query shape:
 *
 *     73 prospects, 207 billable searches, mean 2.8356, range 1 to 3
 *
 * So the real overrun against a cap of 1 is nearly THREE times, not 1.67. The 9-lookup
 * sample was 41% low against the 73-prospect population.
 *
 * CONTROL, because a number read from the same table that produced the error needs one:
 * the 2026-08-25 rows return 4.154 by the identical query, which matches the 4.15 already
 * recorded below from the console reconciliation. The instrument finds a figure we already
 * know, so it can be trusted on the one we do not.
 *
 * RE-TAKE IT RATHER THAN TRUSTING THIS LINE. The absolute number moves with provider
 * behaviour, and the sample size is the part that gets dropped when a figure is quoted
 * onward:
 *
 *     SELECT count(*), sum((raw_web_search->>'search_count')::int),
 *            avg((raw_web_search->>'search_count')::numeric)
 *       FROM prospect_research_results
 *      WHERE raw_web_search ? 'search_count' AND created_at >= '2026-08-26';
 *
 * It is an AVERAGE, like every other figure in this file. Treat it as one.
 */
export const WEB_SEARCH_SEARCHES_PER_PROSPECT = 2.83
/** The measured average under the OLD 2-query shape, before the cap was introduced at all. */
/** The measured average under the OLD 2-query shape. Kept as the baseline to beat. */
export const WEB_SEARCH_SEARCHES_PER_PROSPECT_OLD_MEASURED = 4.15

/**
 * Haiku TOKENS spent performing the searches, per prospect. ESTIMATE.
 *
 * SEPARATE CONSTANT, NOT FOLDED INTO A RANGE. Folding it in is exactly how it stayed
 * invisible and 10x understated: a single blended figure cannot be checked against a
 * console line, and this one never was.
 *
 * Old shape MEASURED $0.042 ($0.55 over 13 prospects). Estimated at $0.021 on the
 * reasoning that the REQUEST count halves from 2 to 1.
 *
 * THAT ESTIMATE WAS CALLED "DELIBERATELY CONSERVATIVE" ON A PREMISE THAT IS NOW FALSE.
 * The old comment argued the true figure was likely LOWER, because the search results
 * injected into each request would fall from ~4.15 searches to 1. They fall to 2.83
 * (see WEB_SEARCH_SEARCHES_PER_PROSPECT), a 32% drop rather than a 76% one, so the
 * injected text — which is the input side of this cost — barely fell at all.
 *
 * Requests halved, injected results did not. The truth is between the two:
 *   scaling by REQUESTS  ->  $0.042 x 1/2       = $0.021   (lower bound)
 *   scaling by SEARCHES  ->  $0.042 x 2.83/4.15 = $0.029   (upper bound)
 *
 * STILL AN ESTIMATE, and the only one left in this file. Settle it by filtering a console
 * day to Haiku and dividing by the prospects researched that day, exactly as the $0.042
 * was settled.
 */
export const COST_WEB_SEARCH_HAIKU_TOKENS = 0.025

/**
 * Total web search cost per prospect: search fees PLUS the Haiku tokens that buy them.
 * Both halves, which is the whole point.
 *
 *   fee    2.83 searches x $0.010  =  $0.0283   MEASURED count, confirmed rate
 *   tokens                            $0.025    ESTIMATE, range $0.021 to $0.029
 *   total                             $0.053
 *
 * WAS $0.031, on an assumed 1 search per prospect. That assumption is dead: the provider
 * does not honour the cap. Old shape MEASURED $0.084, so the 2026-08-25 reduction bought
 * roughly 37%, not the 63% this constant used to claim.
 */
export const COST_WEB_SEARCH_TOTAL = 0.053
export const COST_WEB_SEARCH_TOTAL_OLD_MEASURED = 0.084

// The range is WIDER than this file previously claimed. The old comment said "the cap
// makes the search count exact rather than a distribution" — the cap does nothing of the
// sort. Measured range is 1 to 3 searches per prospect over 73 prospects, so the count is
// a distribution and the band has to carry it as well as the Haiku token spread.
//
//   low  : 1 search  x $0.01 + $0.021 tokens = $0.031
//   high : 3 searches x $0.01 + $0.029 tokens = $0.059
export const COST_WEB_SEARCH_LOW  = 0.031
export const COST_WEB_SEARCH_HIGH = 0.059

// DEAD. NOT A LIVE COST. Composition makes ZERO model calls.
//
// Its only consumer was the bridge sentence in src/lib/composition/personalization.ts,
// and BRIDGE_ENABLED in compose-sequence.ts has been false since 5047e24 (2026-08-19),
// when Email 1 was rewritten as a frame with a slot and the bridge lost its job.
//
// Kept rather than deleted so the number is not silently reintroduced, but it must not be
// summed into any per-prospect cost. It read as live and led the financial model to
// attribute roughly $0.05/prospect to composition, which spends nothing.
//
// The Anthropic cost is entirely at RESEARCH: four Sonnet calls per prospect (synthesis,
// writer, floor judge, judge), plus a retry path that re-runs the writer, so a retried
// prospect costs five or six. That is where prompt caching pays.
//
// If the bridge is ever re-enabled, move this back into the live total in the same commit.
export const HAIKU_PERSONALIZATION_USD_DEAD_BRIDGE_DISABLED = 0.003

// ═════════════════════════════════════════════════════════════════════════════
// PRICING RETURNED USAGE, so a running total is a measurement and not a guess
// ═════════════════════════════════════════════════════════════════════════════
//
// Added 2026-09-25. Everything above this line is a per-prospect AVERAGE, useful for the
// estimate printed before a run starts and wrong for the figure printed during one. The
// batch progress log used to multiply a prospect count by 0.020, which was the midpoint of
// a range this file already records as "roughly 8x low, because they priced ONE call rather
// than four", and it carried no web search at all. So the number an operator watched while
// spending was 7 to 9 times under.
//
// Every Anthropic response carries its own usage. Priced here, a running total is exact for
// every prospect that returned one.
//
// THE CACHE MULTIPLIERS ARE THE POINT. This pipeline reads about six times more cached
// input than fresh input, and a cache read bills at a tenth of the input rate. A price
// table without them is wrong by more than the thing it is measuring.

/** Dollars per million tokens, per model, with the two cache rates Anthropic derives. */
export const USD_PER_MTOK: Record<string, {
  input: number; output: number; cacheWrite: number; cacheRead: number
}> = {
  // 5-minute cache write is 1.25x input, a cache read is 0.1x input.
  'claude-sonnet-4-6':          { input:  3.00, output: 15.00, cacheWrite:  3.75, cacheRead: 0.30 },
  'claude-opus-4-6':            { input: 15.00, output: 75.00, cacheWrite: 18.75, cacheRead: 1.50 },
  'claude-haiku-4-5-20251001':  { input:  1.00, output:  5.00, cacheWrite:  1.25, cacheRead: 0.10 },
}

/**
 * The model the research pipeline's Sonnet calls run on, per ADR-013: synthesis, writer,
 * floor judge, judge, follow-ups and the fact-check.
 *
 * A CONSTANT RATHER THAN A READ-BACK, because TokenUsage does not carry a model and adding
 * one would mean threading it through every addTokenUsage call site. If a stage moves off
 * Sonnet, this and ADR-013 change in the same commit, which is already the standing rule.
 */
export const RESEARCH_SONNET_MODEL = 'claude-sonnet-4-6'

/**
 * AN UNKNOWN MODEL IS PRICED AT THE MOST EXPENSIVE PUBLISHED RATE, NEVER AT ZERO.
 *
 * Same rule as src/lib/tuner/pricing.ts, and for the same reason: a total that silently
 * stops counting when a model is renamed is not a total, and a renamed model is exactly
 * the moment nobody is watching. Overstating is visible; understating is not.
 */
function rateFor(model: string | null): { input: number; output: number; cacheWrite: number; cacheRead: number } {
  const known = model ? USD_PER_MTOK[model] : undefined
  if (known) return known
  return Object.values(USD_PER_MTOK).reduce((a, b) => (b.input > a.input ? b : a))
}

/** What one set of returned token counts cost, in dollars. */
export function usdForTokens(
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  },
  model: string | null,
): number {
  const r = rateFor(model)
  return (
      usage.input_tokens                        * r.input
    + usage.output_tokens                       * r.output
    + (usage.cache_creation_input_tokens ?? 0)  * r.cacheWrite
    + (usage.cache_read_input_tokens ?? 0)      * r.cacheRead
  ) / 1_000_000
}

/**
 * What ONE prospect actually cost, from what the run has in hand.
 *
 * MEASURED where the provider told us, CEILING where it did not:
 *
 *   Sonnet tokens        returned usage, exact
 *   web search tokens    returned usage, exact
 *   web search fees      returned billable count x the console-confirmed $0.01
 *   Apify                COST_APIFY, a ceiling. Apify reports a run's cost through its own
 *                        API and nothing here reads it back, so the ceiling stands in. It
 *                        over-states: measured mean on 2026-09-24 was $0.00726 against the
 *                        $0.01005 ceiling, because a prospect with fewer than MAX_POSTS
 *                        posts bills for fewer.
 *
 * Deliberately NOT included: Apollo enrichment, which is a credit against a prepaid annual
 * allowance rather than a dollar this run spends, and email verification, which happens in
 * a different sweep entirely.
 */
export function prospectCostUsd(args: {
  sonnet: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
  webSearch: { input_tokens: number; output_tokens: number; model: string | null }
  webSearchCount: number
  apifyRan: boolean
}): number {
  return (
      usdForTokens(args.sonnet, RESEARCH_SONNET_MODEL)
    + usdForTokens({ ...args.webSearch }, args.webSearch.model)
    + args.webSearchCount * COST_WEB_SEARCH_PER_SEARCH
    + (args.apifyRan ? COST_APIFY : 0)
  )
}
