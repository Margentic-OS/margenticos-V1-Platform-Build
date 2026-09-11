// Resolving an ambiguous employer name. THE ONLY PART OF THE TUNER THAT COSTS MONEY.
//
// ─── WHEN IT RUNS ────────────────────────────────────────────────────────────
//
// Only where the judge answered "cannot_tell", and only once per distinct name. Everything
// else in the loop is free, so this is the single line that has to be capped, counted and
// reported, and it is the only one where "how many did we do" is a question anyone will ask.
//
// ─── THE CAP IS ENFORCED HERE, NOT BY THE PROVIDER ───────────────────────────
//
// The search tool accepts a max_uses parameter and DOES NOT HONOUR IT AS A BILLABLE BOUND.
//
// MEASURED 2026-09-08 and again on a second run: with max_uses set to 1, nine capped lookups
// returned fifteen billable searches, 1.67 per lookup, and individual lookups returned two
// and three. The parameter is passed correctly and the counting is correct — one search
// result block is one charged search — the provider simply returns more than the cap.
//
// So the cap in this module counts OUR OWN CALLS and stops making them. It does not ask the
// provider to stop. And what it reports is BILLABLE SEARCHES RETURNED, not lookups
// attempted, because those two numbers differ by two thirds and only one of them is the bill.

import { webSearch } from '@/lib/agents/tools/webSearch'
import { logger } from '@/lib/logger'
import { throwIfFatal } from '@/lib/agents/fatal-api-error'
import { PRICE_PER_BILLABLE_SEARCH, tokenCost, isPricedModel, usd } from '@/lib/tuner/pricing'

/**
 * How long one lookup may take.
 *
 * ITS OWN TIMEOUT, because webSearch has none. The eight-second race that exists in this
 * codebase lives inside runResearchQueries, which takes no options at all — a maxUses passed
 * to it is silently dropped, measured 2026-09-08 — so the tuner cannot use that path and does
 * not inherit its timeout either. Measured latency across nine lookups was 5.0 to 7.6
 * seconds, so twenty gives real headroom without letting one lookup eat a round.
 */
const LOOKUP_TIMEOUT_MS = 20_000

/** What we ask the provider for per lookup. Advisory only. See the header. */
const REQUESTED_MAX_USES = 1

export interface LookupResult {
  /** What the lookup returned, stored beside the verdict so a human can see what was read. */
  text: string
  /** True when the lookup came back empty or thin. */
  limited: boolean
  /** BILLABLE searches the provider actually ran. Not the number of lookups. */
  billableSearches: number
  /** The other two thirds of the bill. See webSearch's WebSearchResult for why. */
  inputTokens: number
  outputTokens: number
  /** The model billed, so the tokens can be priced against the right rate. */
  model: string | null
}

/**
 * Counts lookups and billable searches for a whole run, and refuses once the cap is hit.
 *
 * The cap is on LOOKUPS, which is what this module controls. Billable searches are counted
 * and reported but cannot be capped, because the provider decides how many it runs.
 */
export class LookupBudget {
  private lookupsUsed = 0
  private searchesBilled = 0
  private inTokens = 0
  private outTokens = 0
  private unpricedModel = false
  private readonly resolved = new Map<string, LookupResult>()

  /**
   * @param maxLookups  how many lookups this run may make.
   * @param maxUsd      the money ceiling. Infinity means "counted and reported, never enforced",
   *                    which is the right default for a caller that has its own ceiling, and the
   *                    wrong one for anything unattended.
   */
  constructor(readonly maxLookups: number, readonly maxUsd: number = Infinity) {}

  get lookups(): number { return this.lookupsUsed }
  get billableSearches(): number { return this.searchesBilled }
  get inputTokens(): number { return this.inTokens }
  get outputTokens(): number { return this.outTokens }

  /**
   * What has been spent, at list prices. See pricing.ts: an estimate, deliberately allowed
   * to overstate, and never an invoice.
   */
  get spentUsd(): number {
    return this.searchesBilled * PRICE_PER_BILLABLE_SEARCH
      + tokenCost(this.pricingModel, this.inTokens, this.outTokens)
  }

  /** Null once any lookup came back on a model with no published price. See tokenCost. */
  private pricingModel: string | null = null

  /** True if any lookup was priced at the fallback rate rather than a known one. */
  get pricedOnAnUnknownModel(): boolean { return this.unpricedModel }

  /**
   * Exhausted on EITHER limit.
   *
   * Both are counted our side and both are checked before a call, never during one, so the
   * ceiling can only ever stop the NEXT lookup. There is no way to stop a call already in
   * flight, and pretending otherwise would make the ceiling a lie by roughly one lookup.
   */
  get exhausted(): boolean {
    return this.lookupsUsed >= this.maxLookups || this.spentUsd >= this.maxUsd
  }

  /** Which limit stopped it, so a truncated run says why rather than just being short. */
  get stopReason(): 'lookup_cap' | 'money_cap' | null {
    if (this.spentUsd >= this.maxUsd) return 'money_cap'
    if (this.lookupsUsed >= this.maxLookups) return 'lookup_cap'
    return null
  }

  /** A name already looked up this run, if there is one. */
  cached(name: string): LookupResult | undefined {
    return this.resolved.get(normaliseName(name))
  }

  record(name: string, result: LookupResult): void {
    this.lookupsUsed += 1
    this.searchesBilled += result.billableSearches
    this.inTokens += result.inputTokens
    this.outTokens += result.outputTokens
    if (result.model) {
      this.pricingModel = result.model
      if (!isPricedModel(result.model)) this.unpricedModel = true
    }
    this.resolved.set(normaliseName(name), result)
  }

  /** One line, for reporting spend AS IT GOES rather than only at the end. */
  describe(): string {
    return `${this.lookupsUsed} lookups, ${this.searchesBilled} billable searches, ` +
      `${this.inTokens} in / ${this.outTokens} out tokens, ` +
      `${usd(this.spentUsd)}${Number.isFinite(this.maxUsd) ? ` of ${usd(this.maxUsd)}` : ''}` +
      `${this.unpricedModel ? ' (priced at the fallback rate: unknown model)' : ''}`
  }
}

/**
 * Case and whitespace only.
 *
 * DELIBERATELY NOT CLEVER. Stripping corporate suffixes or punctuation would merge two
 * genuinely different organisations whose names differ only by a suffix, and the consequence
 * of that merge is a cached verdict applied to the wrong company. Paying twice for a near
 * duplicate is cheaper than being wrong about one.
 */
function normaliseName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** The question put to the search. Category-level; the employer name arrives at run time. */
export function buildLookupQuery(companyName: string): string {
  return `What does the organisation "${companyName}" sell, and who buys it?`
}

/**
 * Look one employer name up, unless it is already known or the cap is reached.
 *
 * Returns null when the cap is reached, which the caller must render as "still unknown"
 * rather than as "nothing found". Those are different facts: the first says we stopped
 * paying, the second says we paid and learned nothing.
 */
export async function lookUpCompany(
  companyName: string,
  budget: LookupBudget,
): Promise<LookupResult | null> {
  const cached = budget.cached(companyName)
  if (cached) return cached

  if (budget.exhausted) {
    logger.info('tuner: lookup cap reached, name left unresolved', {
      stopped_by: budget.stopReason,
      lookups_used: budget.lookups,
      cap: budget.maxLookups,
      spent_usd: budget.spentUsd,
      cap_usd: budget.maxUsd,
    })
    return null
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      webSearch(buildLookupQuery(companyName), { maxUses: REQUESTED_MAX_USES, brief: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('tuner: lookup timed out')), LOOKUP_TIMEOUT_MS)
      }),
    ])

    const out: LookupResult = {
      text: result.synthesis,
      limited: result.limited,
      billableSearches: result.searchCount,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      model: result.model,
    }
    budget.record(companyName, out)
    return out
  } catch (err) {
    // A BILLING OR AUTH FAILURE IS NOT A COMPANY WE COULD NOT RESEARCH. It is the account, and
    // it is true of every company after this one. This catch used to record it as a failed
    // lookup, which the judge then read as "could not establish" for that company: a verdict
    // about the company, entered into the fit proportion, with no error anywhere. MEASURED
    // 2026-09-10: the credit balance ran out partway through a paid 220-company round, and
    // the run failed loudly only because the judging call after it threw.
    //
    // So it is rethrown, and NOT recorded, because no lookup happened. webSearch already
    // rethrows it as a FatalApiError; this checks again so a change there cannot quietly
    // reopen the hole, and so a raw billing message that reaches here unwrapped is caught too.
    throwIfFatal(err, 'tuner lookup')

    // A failed lookup still costs whatever the provider ran before it failed, and that is not
    // knowable from here. It is counted as one lookup so the cap cannot be bypassed by
    // failures, and as zero billable searches so the reported bill is never overstated.
    const failed: LookupResult = {
      text: '',
      limited: true,
      billableSearches: 0,
      // Same reasoning as billableSearches: a call that threw carries no response body, so
      // the tokens it burned before failing are not knowable from here. Zero is a FLOOR on
      // what was spent, never a claim that nothing was.
      inputTokens: 0,
      outputTokens: 0,
      model: null,
    }
    budget.record(companyName, failed)
    logger.warn('tuner: lookup failed', { error: err instanceof Error ? err.message : String(err) })
    return failed
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Is what came back worth showing a judge?
 *
 * A LOOKUP THAT RETURNED NOTHING USEFUL MUST NOT BECOME A CONFIDENT VERDICT. The whole point
 * of paying for a lookup is to resolve an unknown, and a page that says nothing has not
 * resolved it. Passing thin text to the judge invites it to construct a story from whatever
 * words happened to be on the page, which is worse than the original "cannot tell": it looks
 * like an answer.
 *
 * So a limited or short result is treated as no result at all, and the row stays unresolved.
 */
export const MIN_USEFUL_LOOKUP_CHARS = 80

export function lookupIsUsable(result: LookupResult | null): boolean {
  if (!result) return false
  if (result.limited) return false
  return result.text.trim().length >= MIN_USEFUL_LOOKUP_CHARS
}


/**
 * Research many companies at once, bounded.
 *
 * ─── WHY CONCURRENCY IS SAFE HERE AND NOT ON THE SEARCH PROVIDER ─────────────
 *
 * These are two different providers with two different limits. The sourcing provider allows
 * 600 requests an hour and is SHARED WITH SOURCING, which is why every call to it is
 * throttled and counted. The web lookup is a separate service on a separate account, and
 * nothing else in this system competes for it.
 *
 * Sequentially, eighty lookups at the measured 6.8 seconds each is nine minutes, which put a
 * single round past the wall clock. Ten at a time brings it under a minute.
 *
 * ─── THE CAP IS STILL COUNTED OUR SIDE ───────────────────────────────────────
 *
 * Each worker takes the next index and calls lookUpCompany, which checks the cache and the
 * budget before spending. Concurrency changes the order, never the total: the provider's own
 * limit parameter is not a billable bound and is not relied on here either.
 */
export async function lookUpMany(
  names: (string | null)[],
  budget: LookupBudget,
  concurrency = 10,
): Promise<(LookupResult | null)[]> {
  const out: (LookupResult | null)[] = new Array(names.length).fill(null)
  let next = 0

  // THE FIRST FATAL FAILURE STOPS EVERY WORKER. lookUpCompany throws only for a failure that
  // is true of the account rather than of one company (see its catch). Promise.all rejects on
  // the first one, but it does NOT stop the other workers, and they would go on taking names:
  // for a failure other than a spent balance, that is money spent on a round already declared
  // failed. So every worker checks this before taking another name, the lookups already in
  // flight are allowed to settle, and only then is the error thrown.
  const halt: { hit: boolean; err: unknown } = { hit: false, err: null }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, names.length)) }, async () => {
      for (;;) {
        if (halt.hit) return
        const i = next++
        if (i >= names.length) return
        const name = names[i]
        try {
          out[i] = name ? await lookUpCompany(name, budget) : null
        } catch (err) {
          if (!halt.hit) { halt.hit = true; halt.err = err }
          return
        }
      }
    }),
  )

  if (halt.hit) throw halt.err
  return out
}
