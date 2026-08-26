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

// Apify, per prospect. ONE actor since 2026-08-25: harvestapi~linkedin-profile-posts
// at $2/1000. The profile scraper at $4/1000 was dropped after producing 1 candidate in
// 147, never selected. Was 0.006 when both ran. See src/lib/agents/research/sources/linkedin.ts.
export const COST_APIFY = 0.002

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
// should take it to roughly 16% and the all-in per-prospect figure from $0.245 to $0.192.
// Both are ESTIMATES until a real run is reconciled against the console.

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
 * Searches per prospect.
 *
 * Now EXACTLY 1, because the per-prospect caller passes { maxUses: 1 } and one query
 * cannot exceed its own cap. This is the first figure here that is a hard bound rather
 * than an average. The old shape MEASURED 4.15 (54 searches over 13 prospects).
 */
export const WEB_SEARCH_SEARCHES_PER_PROSPECT = 1
/** The measured average under the OLD 2-query shape. Kept as the baseline to beat. */
export const WEB_SEARCH_SEARCHES_PER_PROSPECT_OLD_MEASURED = 4.15

/**
 * Haiku TOKENS spent performing the searches, per prospect. ESTIMATE.
 *
 * SEPARATE CONSTANT, NOT FOLDED INTO A RANGE. Folding it in is exactly how it stayed
 * invisible and 10x understated: a single blended figure cannot be checked against a
 * console line, and this one never was.
 *
 * Old shape MEASURED $0.042 ($0.55 over 13 prospects). Halved to $0.021 because the
 * REQUEST count halves from 2 to 1. Deliberately conservative: the search results injected
 * into each request also fall from ~4.15 searches to 1, so the true figure is likely lower
 * than this. Estimating the smaller saving is the safer direction to be wrong in.
 */
export const COST_WEB_SEARCH_HAIKU_TOKENS = 0.021

/**
 * Total web search cost per prospect: search fees PLUS the Haiku tokens that buy them.
 * $0.010 fee + $0.021 tokens. Both halves, which is the whole point.
 *
 * Old shape MEASURED $0.084. If the next run does not land near $0.031, this estimate is
 * wrong and the console is right.
 */
export const COST_WEB_SEARCH_TOTAL = 0.031
export const COST_WEB_SEARCH_TOTAL_OLD_MEASURED = 0.084

// The range is now NARROW, because the cap makes the search count exact rather than a
// distribution. The only variance left is Haiku tokens, which move with how much text the
// single search returns.
export const COST_WEB_SEARCH_LOW  = 0.025
export const COST_WEB_SEARCH_HIGH = 0.040

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
