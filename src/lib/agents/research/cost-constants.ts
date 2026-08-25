// Pricing constants for prospect research cost estimation.
// Used by both the batch runner (prospect-research-agent-v2.ts) and the standalone estimate CLI.
// Update here when model pricing changes — one place, both consumers stay in sync.

// Anthropic Sonnet 4.6: ~2500 input × $3/MTok + ~800 output × $15/MTok ≈ $0.020/prospect
export const COST_ANTHROPIC_LOW  = 0.015
export const COST_ANTHROPIC_HIGH = 0.025

// Apify, per prospect. ONE actor since 2026-08-25: harvestapi~linkedin-profile-posts
// at $2/1000. The profile scraper at $4/1000 was dropped after producing 1 candidate in
// 147, never selected. Was 0.006 when both ran. See src/lib/agents/research/sources/linkedin.ts.
export const COST_APIFY = 0.002

// Brave Search: 2 calls per prospect; free tier covers 2000 calls/month
export const BRAVE_FREE_MONTHLY  = 2000
export const BRAVE_PAID_PER_CALL = 0.003

// ─── Anthropic native web search ─────────────────────────────────────────────
//
// THIS FILE PRICED BRAVE AND PRICED THE NATIVE PATH AT NOTHING, and Brave has served
// 3 of the 209 search texts on file. So the line that actually runs was carried at $0
// while the fallback that almost never runs had a cost row of its own. Every per-prospect
// figure derived from this file before 2026-08-25 is understated, including the ones used
// to argue about caching and batching earlier the same day.
//
// WHAT ACTUALLY RUNS. fetchWebSearchSource fires TWO queries per prospect (person and
// company, web-search.ts:37-38). Each is one Haiku request carrying the server-side
// web_search tool, and Anthropic bills that tool PER SEARCH (~$10 per 1,000), on top of
// tokens. Until WEB_SEARCH_MAX_USES was added on 2026-08-25 the searches per request were
// uncapped, so there was no worst case at all.
//
// The Haiku tokens are real but secondary: max_tokens is 512 and the input is one short
// prompt plus whatever the search results inject, so roughly $0.003-$0.005 per prospect
// against $0.02-$0.06 of search fees. Folded into the range below rather than split out.
//
// THESE ARE ESTIMATES, and deliberately labelled as such. web-search.ts now persists
// search_count per run into raw_web_search. Once real runs are on file, replace the
// bounds below with the measured distribution and delete this paragraph.
export const COST_WEB_SEARCH_PER_SEARCH = 0.01
export const WEB_SEARCH_QUERIES_PER_PROSPECT = 2

// Best case: one search per query, both queries answered first time.
export const COST_WEB_SEARCH_LOW  = 0.02
// Worst case: every query runs the full WEB_SEARCH_MAX_USES (3) allowance.
// 2 queries x 3 searches x $0.01 = $0.06, plus Haiku tokens.
export const COST_WEB_SEARCH_HIGH = 0.065

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
