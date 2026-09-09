// What a run may spend, and the audience it may not go below.
//
// ─── WHY THE CAP IS COUNTED HERE AND NOT ASKED OF THE PROVIDER ───────────────
//
// The search tool takes a max_uses parameter and DOES NOT HONOUR IT AS A BILLABLE BOUND.
// Measured across four separate runs with max_uses set to 1: 15 searches for 9 lookups,
// then 8 for 5, then 9 for 6, then 354 for 240. Between 1.5 and 1.75 billable searches per
// lookup, every time, against a requested cap of one.
//
// So the cap is on OUR calls, enforced by counting them before making them. What is reported
// is BILLABLE SEARCHES RETURNED, because that is the bill; reporting lookups attempted would
// understate it by half.
//
// ─── AND WHY IT STOPS BEFORE A SAMPLE RATHER THAN INSIDE ONE ─────────────────
//
// A round costs roughly 120 billable searches at the default sample size. Stopping halfway
// through a sample leaves a partial sample, and a proportion computed on a partial sample is
// biased towards whatever the provider happened to return first. So the check is made BEFORE
// a round begins: if the remaining budget cannot pay for a whole round, the run ends cleanly
// with the rounds it completed rather than adding a half-measured one.

import { logger } from '@/lib/logger'
import { PRICE_PER_BILLABLE_SEARCH, tokenCost, isPricedModel, usd } from '@/lib/tuner/pricing'

/**
 * Billable searches one run may spend.
 *
 * At the default sample size a round costs roughly 120, so this is about three rounds. It is
 * a parameter on every entry point; this is only the default.
 */
export const DEFAULT_SPEND_CAP_SEARCHES = 400

/** Estimated billable searches per researched company. Measured 1.50 to 1.75; rounded up. */
export const BILLABLE_PER_LOOKUP = 1.75

/**
 * Estimated DOLLARS per researched company, all three billed lines together.
 *
 * MEASURED 2026-09-09 over six lookups at $0.02633. Rounded up to leave headroom, for the
 * same reason BILLABLE_PER_LOOKUP is: this figure decides whether a round is STARTED, so
 * understating it is what produces a run that stops halfway through a sample.
 */
export const MEASURED_USD_PER_LOOKUP = 0.03

/**
 * The money ceiling for one run.
 *
 * ─── WHY A SEARCH COUNT WAS NEVER A SPEND CAP ────────────────────────────────
 *
 * A cap counted in searches only bounds 57% of the bill. MEASURED 2026-09-09 over six
 * lookups: the fee was $0.01500 per lookup and the tokens another $0.01133, because the
 * server-side search tool injects the fetched page text into the model's context and that
 * text is charged as input. A run could therefore sit comfortably inside a 400-search cap
 * and spend nearly twice what the cap implied, and nothing in the system would notice,
 * because nothing in the system was counting tokens at all.
 *
 * So the cap is now in dollars, and searches are one of the three things that consume it.
 */
export const DEFAULT_SPEND_CAP_USD = 5.00

export class SpendBudget {
  private searches = 0
  private lookups = 0
  private inTokens = 0
  private outTokens = 0
  private model: string | null = null
  private unpriced = false

  constructor(
    readonly capSearches: number = DEFAULT_SPEND_CAP_SEARCHES,
    readonly capUsd: number = DEFAULT_SPEND_CAP_USD,
  ) {}

  get billableSearches(): number { return this.searches }
  get lookupsMade(): number { return this.lookups }
  get inputTokens(): number { return this.inTokens }
  get outputTokens(): number { return this.outTokens }
  get remaining(): number { return Math.max(0, this.capSearches - this.searches) }

  /** Spent so far at list prices. See pricing.ts: an estimate, allowed to overstate. */
  get spentUsd(): number {
    return this.searches * PRICE_PER_BILLABLE_SEARCH
      + tokenCost(this.model, this.inTokens, this.outTokens)
  }

  get remainingUsd(): number { return Math.max(0, this.capUsd - this.spentUsd) }

  /** True if anything was priced at the fallback rate, so a figure can be flagged as soft. */
  get pricedOnAnUnknownModel(): boolean { return this.unpriced }

  record(billable: number, inputTokens = 0, outputTokens = 0, model: string | null = null): void {
    this.lookups += 1
    this.searches += billable
    this.inTokens += inputTokens
    this.outTokens += outputTokens
    if (model) {
      this.model = model
      if (!isPricedModel(model)) this.unpriced = true
    }
  }

  /**
   * True when a whole round of this size can still be paid for, on BOTH limits.
   *
   * The dollar estimate uses the measured per-lookup figure rather than the search fee alone,
   * for the reason in the class header: a round costs roughly twice its fee. Checking before
   * the round rather than during it is what makes the stop clean; see the module header.
   */
  canAffordRound(sampleSize: number): boolean {
    const searchesOk = this.remaining >= Math.ceil(sampleSize * BILLABLE_PER_LOOKUP)
    const moneyOk = this.remainingUsd >= sampleSize * MEASURED_USD_PER_LOOKUP
    return searchesOk && moneyOk
  }

  /** True when either cap is reached. A round already under way is not interrupted by this. */
  get exhausted(): boolean {
    return this.searches >= this.capSearches || this.spentUsd >= this.capUsd
  }

  /** Which limit stopped it, so a short run says why rather than just being short. */
  get stopReason(): 'search_cap' | 'money_cap' | null {
    if (this.spentUsd >= this.capUsd) return 'money_cap'
    if (this.searches >= this.capSearches) return 'search_cap'
    return null
  }

  describe(): string {
    return `${this.searches} billable searches across ${this.lookups} lookups (cap ${this.capSearches}), ` +
      `${this.inTokens} in / ${this.outTokens} out tokens, ` +
      `${usd(this.spentUsd)} of ${usd(this.capUsd)}` +
      `${this.unpriced ? ' (priced at the fallback rate: unknown model)' : ''}`
  }
}

/**
 * The audience a proposed search may not fall below.
 *
 * ─── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
 *
 * Optimising for a clean sample rewards making the search tiny. A search returning four
 * companies, all of them perfect, scores 100% and serves nobody: there is nothing to send.
 * Without a floor the loop's own objective points at that answer, and it would reach it
 * honestly.
 *
 * ─── AND WHY THERE IS NO DEFAULT ─────────────────────────────────────────────
 *
 * How large an audience a client needs is a commercial fact about their contract, and it is
 * not stored anywhere: `monthly_meetings_target` is a meetings figure, and the project's own
 * documents carry at least four monthly volume figures that disagree by up to a factor of
 * three. Choosing one here would be this module settling a commercial question from whichever
 * document it happened to read. So it is supplied or the run says it cannot judge.
 */
export interface AudienceFloor {
  /** The smallest acceptable reachable population. */
  minimumReachable: number
  /** Where the figure came from, so a reader can challenge it. */
  source: string
}

export interface AudienceVerdict {
  acceptable: boolean
  /** Null when no floor was supplied: "cannot judge", never "passed". */
  judged: boolean
  reason: string
}

export function checkAudience(reachable: number, floor: AudienceFloor | undefined): AudienceVerdict {
  if (!floor) {
    return {
      acceptable: false,
      judged: false,
      reason:
        'No required audience size was supplied, so this run cannot say whether a candidate ' +
        'search reaches enough people. Nothing is assumed: the figure is a fact about the ' +
        "client's contract, it is not stored on the organisation record, and the project's " +
        'own documents carry several monthly volume figures that disagree. Supply one to let ' +
        'the loop reject candidates that score well by being tiny.',
    }
  }
  if (reachable >= floor.minimumReachable) {
    return {
      acceptable: true, judged: true,
      reason: `Reaches ${reachable} against a required ${floor.minimumReachable} (${floor.source}).`,
    }
  }
  return {
    acceptable: false, judged: true,
    reason:
      `REJECTED ON REACH, whatever its sample looked like: reaches ${reachable} against a ` +
      `required ${floor.minimumReachable} (${floor.source}). A cleaner sample does not ` +
      'compensate for an audience too small to serve, and the trade is refused here rather ' +
      'than being scored as an improvement.',
  }
}

export function logSpend(budget: SpendBudget, modelCalls: number): void {
  logger.info('tuner: spend', {
    billable_searches: budget.billableSearches,
    lookups: budget.lookupsMade,
    cap: budget.capSearches,
    remaining: budget.remaining,
    input_tokens: budget.inputTokens,
    output_tokens: budget.outputTokens,
    spent_usd: budget.spentUsd,
    cap_usd: budget.capUsd,
    model_calls: modelCalls,
  })
}
