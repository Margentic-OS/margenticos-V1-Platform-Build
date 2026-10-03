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
  // CORRECTED 2026-10-02, read from Anthropic's published pricing page that day: $5 input,
  // $25 output per million. It held $15 / $75, the retired Opus 4.1 price, so every Opus
  // figure printed from this table before that date was three times too high. The same row
  // in src/lib/agents/research/cost-constants.ts was corrected in the same change.
  'claude-opus-4-6': { input: 5.00 / 1e6, output: 25.00 / 1e6 },
}

/** Dollars per billable search returned by the server-side search tool. */
export const PRICE_PER_BILLABLE_SEARCH = 10 / 1000

/**
 * What an unknown model is priced at: $15 input, $75 output per million tokens, the retired
 * Opus 4 and 4.1 price and the dearest per-token Claude rate this code has been pointed at.
 * The dearest current model in the API reference read on 2026-10-02 is $10 / $50, so the
 * ceiling stands above every model now offered.
 *
 * AN EXPLICIT CEILING, NOT THE DEAREST ROW ABOVE. Until 2026-10-02 an unknown model was
 * priced at the table's dearest row, which was the Opus row. Corrected that day to $5 / $25,
 * it would have priced a dearer model missing from the table at a third of its cost.
 * src/lib/agents/research/cost-constants.ts holds the same ceiling; change both together.
 */
export const UNKNOWN_MODEL_PRICE = { input: 15.00 / 1e6, output: 75.00 / 1e6 } as const

/**
 * What one model's tokens cost.
 *
 * AN UNKNOWN MODEL IS PRICED AT THE CEILING ABOVE, NEVER AT ZERO. A ceiling that silently
 * stops counting when a model is renamed is not a ceiling, and a renamed model is exactly
 * the moment nobody is watching. Overstating stops a run early and is visible;
 * understating spends real money and is not.
 */
export function tokenCost(model: string | null, inputTokens: number, outputTokens: number): number {
  const price = (model && MODEL_PRICES[model]) || UNKNOWN_MODEL_PRICE
  return inputTokens * price.input + outputTokens * price.output
}

/** True when this model has a published price here, so a caller can say "priced as unknown". */
export function isPricedModel(model: string | null): boolean {
  return !!model && model in MODEL_PRICES
}

export function usd(amount: number): string {
  return `$${amount.toFixed(4)}`
}
