// Pricing constants for prospect research cost estimation.
// Used by both the batch runner (prospect-research-agent-v2.ts) and the standalone estimate CLI.
// Update here when model pricing changes — one place, both consumers stay in sync.

// Anthropic Sonnet 4.6: ~2500 input × $3/MTok + ~800 output × $15/MTok ≈ $0.020/prospect
export const COST_ANTHROPIC_LOW  = 0.015
export const COST_ANTHROPIC_HIGH = 0.025

// Apify harvestapi/linkedin-profile-scraper, per run
export const COST_APIFY = 0.006

// Brave Search: 2 calls per prospect; free tier covers 2000 calls/month
export const BRAVE_FREE_MONTHLY  = 2000
export const BRAVE_PAID_PER_CALL = 0.003

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
