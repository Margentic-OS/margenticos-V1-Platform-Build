// Search words derived from what the client sells, and then MEASURED before being trusted.
//
// ─── WHAT THIS REPLACES ──────────────────────────────────────────────────────
//
// The stored spec's words are computed from the NAMES OF THE CLIENT'S INDUSTRY BUCKETS:
// each canonical name lowercased, plus its last word. That is a fact about the taxonomy's
// spelling, not about the client's business, and it has one hand-written list of generic
// words guarding it.
//
// MEASURED 2026-09-08 across all three live organisations. Of twelve derived words, SEVEN
// move the reachable population by less than one percent and also match zero stored
// prospects. On one organisation the entire word layer is inert: removing it changes the
// population not at all. On another, one word alone accounts for 99% of the layer's yield
// and the other three are decoration. The full bucket names contribute almost nothing; the
// last word carries whatever effect there is.
//
// ─── WHAT REPLACES IT, AND WHY IT NEEDS NO LIST ──────────────────────────────
//
// Candidates come from the client's own documents, in the client's own words, on the single
// model call the run already makes. Then every candidate is MEASURED against the provider,
// alone, and compared with the population when no word layer is applied at all. A word that
// finds nobody is dropped. A word that finds everybody is dropped, because a word matching
// the whole population constrains nothing.
//
// That measurement is what makes the hand-written generic list unnecessary. A generic word
// is exactly a word that matches nearly everything, and this detects that per client rather
// than by having decided in advance which words are generic — which is a judgement that can
// only be right for one market at a time. It names nothing and it self-corrects.

import { countAndSample, type ProviderBudget } from '@/lib/tuner/count-and-sample'
import { matchesTargetKeywords } from '@/lib/sourcing/tier-classification'
import { WEAK_SHARE } from '@/lib/tuner/differencing'

const WORD_KEY = 'q_organization_keyword_tags'

export interface MeasuredWord {
  word: string
  /** Population with this word as the only word, everything else unchanged. */
  alone: number
  /** True when it narrows: it finds somebody, and not everybody. */
  keep: boolean
  reason: string
}

export interface WordMeasurement {
  /** Population with no word layer at all. The denominator for everything here. */
  withoutWordLayer: number
  candidates: MeasuredWord[]
  kept: string[]
  dropped: string[]
}

/**
 * Measure each candidate word alone against the population with no word layer.
 *
 * Two provider calls plus one per candidate. All free.
 *
 * ─── THE TWO WAYS A WORD FAILS, AND THEY ARE NOT THE SAME FAILURE ────────────
 *
 *   FINDS NOBODY     `alone` is zero, or below the weak share of the population. The word
 *                    is not in use in this market, or not in organisation names.
 *   FINDS EVERYBODY  `alone` equals the no-word-layer population. The word is inside every
 *                    name the other constraints already select, so adding it constrains
 *                    nothing. This is what "generic" means, measured rather than declared.
 *
 * Both are dropped and both reasons are recorded, because an operator reading the plan wants
 * to know which one happened. A market where every candidate finds everybody is a market
 * whose names do not discriminate, and that is worth knowing; a market where every candidate
 * finds nobody usually means the words are wrong.
 */
export async function measureCandidateWords(
  request: Record<string, unknown>,
  candidates: readonly string[],
  budget: ProviderBudget,
): Promise<WordMeasurement> {
  const withoutLayer = { ...request }
  delete withoutLayer[WORD_KEY]

  const withoutWordLayer = (await countAndSample(withoutLayer, budget)).total

  const measured: MeasuredWord[] = []
  for (const word of candidates) {
    const alone = (await countAndSample({ ...withoutLayer, [WORD_KEY]: [word] }, budget)).total

    if (alone === 0) {
      measured.push({ word, alone, keep: false, reason: 'Finds nobody at all.' })
      continue
    }
    if (alone >= withoutWordLayer) {
      measured.push({
        word, alone, keep: false,
        reason:
          `Matches the whole reachable population (${alone} of ${withoutWordLayer}), so it ` +
          'narrows nothing.',
      })
      continue
    }
    if (alone < WEAK_SHARE * withoutWordLayer) {
      measured.push({
        word, alone, keep: false,
        reason:
          `Finds ${alone} of ${withoutWordLayer}, under the ${WEAK_SHARE * 100}% floor. Too ` +
          'few to be worth constraining on.',
      })
      continue
    }
    measured.push({
      word, alone, keep: true,
      reason: `Narrows to ${alone} of ${withoutWordLayer}.`,
    })
  }

  return {
    withoutWordLayer,
    candidates: measured,
    kept: measured.filter(m => m.keep).map(m => m.word),
    dropped: measured.filter(m => !m.keep).map(m => m.word),
  }
}

// ─── The second effect: grading ──────────────────────────────────────────────

export interface GradingComparison {
  prospectsExamined: number
  /** Prospects the CURRENT word list rescues. */
  matchedByCurrent: number
  /** Prospects the PROPOSED word list would rescue. */
  matchedByProposed: number
  /** Prospects whose rescue verdict differs between the two lists. */
  verdictsChanged: number
  /** True when the two lists grade every existing prospect identically. */
  identical: boolean
  note: string
}

/** One stored prospect, reduced to the two fields the rescue actually reads. */
export interface GradedProspect {
  id: string
  company_name: string | null
  job_title: string | null
}

/**
 * Would swapping the word list change how any EXISTING prospect is graded?
 *
 * ─── WHY THIS IS ASKED SEPARATELY FROM THE SEARCH EFFECT ─────────────────────
 *
 * The same word list feeds two different things: the provider query, and a rescue inside the
 * tier classifier that saves an off-target prospect when one of the words appears in its
 * company name or job title. Optimising the list for the search silently re-grades the
 * stored population, and the two effects would then be impossible to attribute: a change in
 * survivor count could be the new search or the new rescue and nothing would say which.
 *
 * So this runs the REAL rescue function, imported from the tier classifier rather than
 * reimplemented, over every stored prospect under both lists, and reports whether any
 * verdict differs.
 *
 * IT WRITES NOTHING AND RE-GRADES NOTHING. It computes what the verdict would be; no
 * prospect row is read for update, none is written, and no tiering run is triggered.
 *
 * MEASURED 2026-09-08: across all three live organisations, ZERO prospects carry the
 * `industry_off_target` removal reason, so the rescue has never once fired. The two effects
 * are therefore separable today, and this function is what demonstrates that on the day it
 * runs rather than assuming it still holds.
 */
export function compareGrading(
  prospects: readonly GradedProspect[],
  currentWords: readonly string[],
  proposedWords: readonly string[],
): GradingComparison {
  let matchedByCurrent = 0
  let matchedByProposed = 0
  let verdictsChanged = 0

  for (const p of prospects) {
    const before = matchesTargetKeywords(p.company_name, p.job_title, currentWords)
    const after = matchesTargetKeywords(p.company_name, p.job_title, proposedWords)
    if (before) matchedByCurrent++
    if (after) matchedByProposed++
    if (before !== after) verdictsChanged++
  }

  return {
    prospectsExamined: prospects.length,
    matchedByCurrent,
    matchedByProposed,
    verdictsChanged,
    identical: verdictsChanged === 0,
    note:
      verdictsChanged === 0
        ? `The proposed word list grades all ${prospects.length} stored prospects identically ` +
          'to the current one, so the search effect and the grading effect are not confounded ' +
          'and any change in the search can be attributed to the search alone.'
        : `The proposed word list would change the rescue verdict for ${verdictsChanged} of ` +
          `${prospects.length} stored prospects. The search effect and the grading effect are ` +
          'CONFOUNDED: a change in survivors after this could be either. Nothing has been ' +
          're-graded, and nothing will be by this run.',
  }
}
