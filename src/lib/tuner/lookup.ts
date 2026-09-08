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
  private readonly resolved = new Map<string, LookupResult>()

  constructor(readonly maxLookups: number) {}

  get lookups(): number { return this.lookupsUsed }
  get billableSearches(): number { return this.searchesBilled }
  get exhausted(): boolean { return this.lookupsUsed >= this.maxLookups }

  /** A name already looked up this run, if there is one. */
  cached(name: string): LookupResult | undefined {
    return this.resolved.get(normaliseName(name))
  }

  record(name: string, result: LookupResult): void {
    this.lookupsUsed += 1
    this.searchesBilled += result.billableSearches
    this.resolved.set(normaliseName(name), result)
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
  return `What does the organisation "${companyName}" do, what does it sell, and who are its customers?`
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
      lookups_used: budget.lookups,
      cap: budget.maxLookups,
    })
    return null
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      webSearch(buildLookupQuery(companyName), { maxUses: REQUESTED_MAX_USES }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('tuner: lookup timed out')), LOOKUP_TIMEOUT_MS)
      }),
    ])

    const out: LookupResult = {
      text: result.synthesis,
      limited: result.limited,
      billableSearches: result.searchCount,
    }
    budget.record(companyName, out)
    return out
  } catch (err) {
    // A failed lookup still costs whatever the provider ran before it failed, and that is not
    // knowable from here. It is counted as one lookup so the cap cannot be bypassed by
    // failures, and as zero billable searches so the reported bill is never overstated.
    const failed: LookupResult = {
      text: '',
      limited: true,
      billableSearches: 0,
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
