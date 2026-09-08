// Per-tier populations, and the rows that belong to neither tier.
//
// ─── WHY THIS IS A SEPARATE MEASUREMENT ──────────────────────────────────────
//
// A client's document states two targeting tiers. The spec derivation merges them BEFORE
// the search: industries become the set union of the two, and the headcount band becomes
// the minimum across both to the maximum across both. Which tier a prospect actually
// belongs to is decided much later, by the tier classifier, on rows that have already been
// paid for.
//
// The merge is not a union of the two populations. It is a CROSS PRODUCT: the union of
// industries at the union of sizes, which admits companies in one tier's industries at the
// other tier's sizes, matching neither tier's definition of anything.
//
// MEASURED 2026-09-08 on a live organisation whose two tiers share no industry at all:
// tier one alone 8,489, tier two alone 247, and the combined query 11,192. The two tiers
// are disjoint, so their sum is a true disjoint sum, and at least 2,456 rows — 21.9% of
// everything sourced for that client — belong to neither tier. On the same run the smaller
// tier was 2.2% of the combined population, so a random sample from it would essentially
// never contain one.
//
// Both facts are invisible from the combined count alone, which is why this runs on every
// round zero rather than on request.

import type { TierCounts } from '@/lib/tuner/types'
import { buildApolloRequest } from '@/lib/sourcing/handlers/adapter-apollo'
import { countAndSample, type ProviderBudget } from '@/lib/tuner/count-and-sample'
import { logger } from '@/lib/logger'

/** The shape this reads off a client's ICP document. Nothing else about the tiers matters here. */
interface TierProfile {
  industries?: string[]
  headcount?: string
}

/**
 * Parse the bounds out of a document's human-written headcount phrase.
 *
 * DELIBERATELY LENIENT AND DELIBERATELY NON-AUTHORITATIVE. The spec derivation has its own
 * parser and that one is the source of truth for what gets stored. This one exists only to
 * split a combined search into two for COUNTING, and a count that cannot be produced is
 * reported as such rather than guessed at. It never writes anything and never feeds a spec.
 */
export function parseHeadcountPhrase(phrase: string | undefined): { min: number | null; max: number | null } {
  const digits = (phrase ?? '').match(/\d[\d,]*/g)?.map(n => Number(n.replace(/,/g, ''))) ?? []
  if (digits.length === 0) return { min: null, max: null }
  if (digits.length === 1) {
    return /\+|over|more|above/i.test(phrase ?? '')
      ? { min: digits[0], max: null }
      : { min: digits[0], max: digits[0] }
  }
  return { min: Math.min(...digits), max: Math.max(...digits) }
}

/**
 * Count each tier on its own terms, and the combined query as it is actually sourced.
 *
 * Returns null when the document does not carry two usable tiers. A null here is "this
 * cannot be measured", not "the tiers agree", and the caller must not render it as the
 * second.
 */
export async function countTiers(
  spec: Record<string, unknown>,
  icpContent: Record<string, unknown>,
  budget: ProviderBudget,
): Promise<TierCounts | null> {
  const t1 = ((icpContent?.tier_1 as Record<string, unknown>)?.company_profile ?? null) as TierProfile | null
  const t2 = ((icpContent?.tier_2 as Record<string, unknown>)?.company_profile ?? null) as TierProfile | null
  if (!t1 || !t2) return null

  const i1 = Array.isArray(t1.industries) ? t1.industries : []
  const i2 = Array.isArray(t2.industries) ? t2.industries : []
  if (i1.length === 0 || i2.length === 0) return null

  const r1 = parseHeadcountPhrase(t1.headcount)
  const r2 = parseHeadcountPhrase(t2.headcount)

  const combined = (await countAndSample(buildApolloRequest(spec), budget)).total

  const forTier = async (industries: string[], range: { min: number | null; max: number | null }) => {
    const sub = buildApolloRequest({
      ...spec,
      industries,
      company_headcount_min: range.min ?? spec.company_headcount_min,
      company_headcount_max: range.max ?? spec.company_headcount_max,
    })
    return (await countAndSample(sub, budget)).total
  }

  let tierOne: number
  let tierTwo: number
  try {
    tierOne = await forTier(i1, r1)
    tierTwo = await forTier(i2, r2)
  } catch (err) {
    // A tier the request builder refuses is a tier that cannot be counted, which is a real
    // answer about the document. It is not a reason to fail the round.
    logger.warn('tuner: per-tier count refused', { error: err instanceof Error ? err.message : String(err) })
    return null
  }

  // ─── The disjointness condition, and why the cross product depends on it ───
  //
  // `combined - (tierOne + tierTwo)` is a lower bound on rows belonging to neither tier
  // ONLY when the tiers share no industry. When they overlap, the two counts double-count
  // their intersection and the subtraction produces a large negative number that means
  // nothing at all. Reporting that as "rows belonging to neither tier" would be arithmetic
  // presented as a finding, so it is null instead.
  const shared = i1.filter(x => i2.includes(x))
  const tiersDisjoint = shared.length === 0

  return {
    combined,
    tierOne,
    tierTwo,
    tiersDisjoint,
    neitherTier: tiersDisjoint ? Math.max(0, combined - (tierOne + tierTwo)) : null,
    smallerTierShare: combined > 0 ? Math.min(tierOne, tierTwo) / combined : 0,
  }
}
