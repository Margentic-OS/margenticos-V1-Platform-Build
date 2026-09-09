// What a run actually costs, in dollars, from the three things that are billed.
//
// ─── WHY THIS MODULE EXISTS ──────────────────────────────────────────────────
//
// Until 2026-09-09 this project costed the search fee and nothing else, because the fee was
// the only number any code path recorded. webSearch computed the token usage on every single
// call and discarded it. So the cost model was not an underestimate arrived at by rounding,
// it was a measurement of one third of the bill presented as the whole of it.
//
// MEASURED 2026-09-09, six lookups, claude-haiku-4-5-20251001, default framing:
//
//   billable searches   1.50 per lookup    $0.01500   57%
//   input tokens        9,487 per lookup   $0.00949   36%
//   output tokens       368 per lookup     $0.00184    7%
//   TOTAL                                  $0.02633
//
// The input line is 9,487 tokens to produce a 930-character answer. That is the whole of the
// page text the search tool injects, and it is the line nobody was looking at.
//
// ─── THESE ARE LIST PRICES, NOT AN INVOICE ───────────────────────────────────
//
// A figure computed here is an estimate against published rates. It does not know about
// discounts, and it does not include prompt caching, which would only ever make it lower.
// It is a CEILING to stop a run overspending, and it is deliberately allowed to overstate.
// Anything reported from it must say which prices it used, which is why they are named
// rather than inlined.

/** Dollars per token. Named per model so a figure can never be read against the wrong one. */
export const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': { input: 1.00 / 1e6, output: 5.00 / 1e6 },
  'claude-sonnet-4-6': { input: 3.00 / 1e6, output: 15.00 / 1e6 },
  'claude-opus-4-6': { input: 15.00 / 1e6, output: 75.00 / 1e6 },
}

/** Dollars per billable search returned by the server-side search tool. */
export const PRICE_PER_BILLABLE_SEARCH = 10 / 1000

/**
 * What one model's tokens cost.
 *
 * AN UNKNOWN MODEL IS PRICED AT THE MOST EXPENSIVE RATE, NEVER AT ZERO. A ceiling that
 * silently stops counting when a model is renamed is not a ceiling, and a renamed model is
 * exactly the moment nobody is watching. Overstating stops a run early and is visible;
 * understating spends real money and is not.
 */
export function tokenCost(model: string | null, inputTokens: number, outputTokens: number): number {
  const price = (model && MODEL_PRICES[model]) || mostExpensive()
  return inputTokens * price.input + outputTokens * price.output
}

function mostExpensive(): { input: number; output: number } {
  return Object.values(MODEL_PRICES).reduce((a, b) => (b.input > a.input ? b : a))
}

/** True when this model has a published price here, so a caller can say "priced as unknown". */
export function isPricedModel(model: string | null): boolean {
  return !!model && model in MODEL_PRICES
}

export function usd(amount: number): string {
  return `$${amount.toFixed(4)}`
}
