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

// Haiku 4.5 composition personalisation: ~1500 input × $0.80/MTok + ~600 output × $4/MTok ≈ $0.003
export const HAIKU_PERSONALIZATION_USD = 0.003
