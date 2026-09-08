// The ceiling: the population with the buyer constraints relaxed.
//
// ─── WHY BOTH FIGURES, ON EVERY RUN ──────────────────────────────────────────
//
// A small population has two completely different causes and the count alone cannot tell
// them apart:
//
//   THE SEARCH IS TOO TIGHT      the audience is there; the constraints are cutting it away.
//                                Tuning helps, and the ceiling is large.
//   THE AUDIENCE DOES NOT EXIST  there is nobody to find. Tuning cannot help, and no
//                                amount of it will, so continuing is inventing a result.
//                                The ceiling is small too.
//
// The ceiling turns that from an inference into a measurement. It is the same query with
// the person-side constraints removed and everything else — the classification codes, the
// size band, the geography — left exactly as the client's document states it.
//
// MEASURED 2026-09-08 on a live organisation whose search returns ONE person:
//
//   as configured                     1
//   job titles relaxed               87
//   seniority relaxed               104
//   both relaxed                    879      <- the ceiling
//   geography and size only      97,772      <- the positive control, not the ceiling
//
// The ceiling of 879 is the finding. It says the tightness is real and also that fixing it
// completely still leaves an audience far too small to serve a contract, so the answer for
// that client is a commercial conversation and not another round of tuning. Neither half of
// that is visible from the population of 1.
//
// ─── WHAT IS RELAXED, AND WHAT IS NOT ────────────────────────────────────────
//
// ONLY the two person-side layers. The classification codes stay, because relaxing those
// asks a different question — whether the taxonomy fits at all — which has its own
// measurement. The size band stays, because it comes from the client's own document. The
// geography stays, and it must: relaxing it would produce a ceiling that includes places
// the client has not asked for and, worse, places the legal subtraction removes. A ceiling
// nobody is allowed to reach is not a ceiling.

import { countAndSample, type ProviderBudget } from '@/lib/tuner/count-and-sample'

/**
 * The request keys the ceiling relaxes. Both are person-side.
 *
 * Named as a constant rather than inlined so the test can assert exactly this set, and so
 * that a third key cannot be added to the relaxation without the test noticing.
 */
export const RELAXED_KEYS = ['person_titles', 'person_seniorities'] as const

export interface Ceiling {
  /** The population as the client's spec actually configures it. */
  baseline: number
  /** The population with the buyer constraints relaxed. */
  ceiling: number
  /**
   * True when relaxing the buyer constraints barely moves the population, so the
   * constraints are not what is limiting it.
   */
  buyerConstraintsAreNotTheLimit: boolean
}

/**
 * At or below this ratio of ceiling to baseline, the buyer constraints are not the limit.
 *
 * JUDGEMENT. A ceiling within a fifth of the baseline means relaxing every person-side
 * constraint the client stated buys almost nothing, so whatever is limiting the population
 * is upstream of the buyer definition and loosening titles will not find it.
 */
export const CEILING_MARGIN = 1.2

export async function measureCeiling(
  request: Record<string, unknown>,
  budget: ProviderBudget,
  baseline: number,
): Promise<Ceiling> {
  const relaxed = { ...request }
  for (const key of RELAXED_KEYS) delete relaxed[key]

  const ceiling = (await countAndSample(relaxed, budget)).total

  return {
    baseline,
    ceiling,
    buyerConstraintsAreNotTheLimit: baseline > 0 && ceiling <= baseline * CEILING_MARGIN,
  }
}
