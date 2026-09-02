// The client's buyer criterion: who this client will actually email.
//
// ─── WHY THIS IS NOT seniority_levels ────────────────────────────────────────
//
// They are different questions and conflating them costs inventory.
//
//   seniority_levels  is what we ask the SOURCING PROVIDER for. It is deliberately
//                     wide, because a provider derives seniority from job title and
//                     is coarse about it. Narrowing it was measured at 29,139 rows
//                     against 72,458. It stays wide. NOTHING IN THIS FILE READS IT.
//
//   the buyer criterion is who we will actually email, out of what the wide search
//                     returned. It is narrower, and it is derived per client from
//                     that client's own documents.
//
// A single list serving both jobs is how twelve hardcoded title fragments ended up
// applied identically to every client, including one whose market shares no
// vocabulary with the list. That list is deleted, not parameterised.
//
// ─── RULE ZERO ───────────────────────────────────────────────────────────────
//
// This module contains no job titles, no industries and no buyer archetypes, in
// code, comments or test fixtures. The fragments it matches on arrive at run time
// from a client's derived spec. The category-level question the derivation answers
// is stated once, in the agent that asks it, and nowhere else.

/**
 * One title fragment the client's buyer criterion accepts, and how strongly.
 *
 * The rank exists because the fit score has always had a seniority ladder, and
 * deleting the ladder would silently re-tier every survivor. `primary` is the
 * person who owns the problem, controls the spend and can convene the decision;
 * `secondary` is one who holds some but not all of those. Two ranks, not three:
 * the old middle band existed only as an artefact of the hardcoded list's ordering.
 */
export interface BuyerTitleFragment {
  /** Lowercase. Matched as a substring against a tokenised job title. */
  fragment: string
  rank: 'primary' | 'secondary'
}

/**
 * The outcome of the sanity band, stored so an operator can see what the criterion
 * was measured against rather than having to trust that it was measured at all.
 */
export interface BuyerCriterionSanity {
  /** False when there were too few sourced titles to measure against. */
  checked: boolean
  sample_size: number
  /** Proportion of the sample the criterion accepts. Null when not checked. */
  accept_rate: number | null
  note: string
}

export interface BuyerCriterion {
  /**
   * `derived`     the gate applies it.
   * `unsettled`   the documents do not settle who decides. The gate does NOT apply it.
   * `out_of_band` it accepts or rejects almost everything. The gate does NOT apply it.
   *
   * Only `derived` gates. Both other states fail OPEN, loudly: a criterion nobody has
   * validated must not quietly stop a client's pipeline, and a gate that rejects
   * everything is indistinguishable from a client with no prospects.
   */
  status: 'derived' | 'unsettled' | 'out_of_band'
  accept: BuyerTitleFragment[]
  /**
   * Fragments that disqualify even when an accept fragment also matched. This is what
   * separates a decision-maker from someone whose title merely contains one, such as a
   * support or proxy role named after the person they support.
   */
  reject: string[]
  /**
   * Plain English, written to be read aloud on an onboarding call. This is how the
   * operator validates a judgement the system made on the client's behalf. It is not
   * a log line and it is not optional.
   */
  statement: string
  /** What in the client's own documents supports the statement. */
  evidence: string[]
  /** Present when status is `unsettled`: what the documents leave open. */
  unsettled_reason: string | null
  sanity: BuyerCriterionSanity | null
  derived_at: string
  model: string
}

// ─── The sanity band ─────────────────────────────────────────────────────────
//
// A criterion that rejects almost every sourced title looks exactly like a client
// with no prospects, and a criterion that accepts almost every one is not a
// criterion. Both are surfaced rather than applied.
//
// The thresholds are judgement, and they are stated here rather than buried:
//
//   Below MIN_SANITY_SAMPLE distinct titles the band is NOT CHECKED and says so.
//   A rate measured on a handful of titles would be noise presented as a finding,
//   and a new client legitimately has nothing to measure against.
//
//   Outside 5% to 95% the criterion is stored as `out_of_band` and does not gate.
//   The band is wide on purpose. A legitimately narrow criterion against a wide
//   provider search can accept well under a fifth of what comes back, so a tighter
//   band would fire on correct derivations and teach the operator to ignore it.

export const MIN_SANITY_SAMPLE = 25
export const MIN_ACCEPT_RATE = 0.05
export const MAX_ACCEPT_RATE = 0.95

/** Fit-score points for an accepted title. Mirrors the ladder this replaced. */
export const SENIORITY_SCORE_PRIMARY = 35
export const SENIORITY_SCORE_SECONDARY = 25

/**
 * Split a job title into the parts a person actually holds.
 *
 * ONE TOKENISER, read by the gate and by the fit score. Those were two copies of the
 * same knowledge and had already drifted apart before this file existed.
 */
export function tokeniseJobTitle(jobTitle: string): string[] {
  return jobTitle
    .toLowerCase()
    .split(/[&/|+,]|\band\b/)
    .map(part => part.trim())
    .filter(part => part.length > 0)
}

export type BuyerVerdict =
  /** The criterion applies and accepts. `rank` drives the fit score. */
  | { decision: 'accept'; rank: 'primary' | 'secondary' }
  /** The criterion applies and rejects. */
  | { decision: 'reject' }
  /**
   * The criterion does not apply, so nothing was decided. The caller must fail OPEN
   * and warn. Distinguishing this from `accept` is the whole point: "we checked and
   * this person qualifies" and "we never checked" must not look the same downstream.
   */
  | { decision: 'no_criterion'; why: 'absent' | 'unsettled' | 'out_of_band' }
  /** No title to judge. Also fails open here; a null title is caught by its own rule. */
  | { decision: 'no_title' }

/**
 * Apply a client's buyer criterion to one job title.
 *
 * Pure. No database, no client_id, no ambient state — the criterion is passed in, which
 * is what makes this safe to call from both the pre-enrichment gate and the tier
 * classifier and get the same answer from both.
 */
export function evaluateBuyerCriterion(
  criterion: BuyerCriterion | null | undefined,
  jobTitle: string | null,
): BuyerVerdict {
  if (!criterion) return { decision: 'no_criterion', why: 'absent' }
  if (criterion.status === 'unsettled') return { decision: 'no_criterion', why: 'unsettled' }
  if (criterion.status === 'out_of_band') return { decision: 'no_criterion', why: 'out_of_band' }

  // A criterion with nothing to accept cannot decide anything. Treating it as a
  // rejection of every title would be the silent-total-rejection failure the sanity
  // band exists to catch, arriving by a different route.
  if (criterion.accept.length === 0) return { decision: 'no_criterion', why: 'absent' }

  if (!jobTitle || jobTitle.trim() === '') return { decision: 'no_title' }

  const parts = tokeniseJobTitle(jobTitle)

  // Reject wins over accept, and is checked first. A proxy role is usually named after
  // the role it supports, so it matches an accept fragment by construction.
  for (const bad of criterion.reject) {
    const needle = bad.toLowerCase().trim()
    if (needle && parts.some(part => part.includes(needle))) return { decision: 'reject' }
  }

  let best: 'primary' | 'secondary' | null = null
  for (const entry of criterion.accept) {
    const needle = entry.fragment.toLowerCase().trim()
    if (!needle) continue
    if (parts.some(part => part.includes(needle))) {
      if (entry.rank === 'primary') return { decision: 'accept', rank: 'primary' }
      best = 'secondary'
    }
  }

  return best ? { decision: 'accept', rank: best } : { decision: 'reject' }
}

/** Fit-score points for a verdict. Reads the same evaluation the gate read. */
export function seniorityScoreFor(verdict: BuyerVerdict): number {
  if (verdict.decision !== 'accept') return 0
  return verdict.rank === 'primary' ? SENIORITY_SCORE_PRIMARY : SENIORITY_SCORE_SECONDARY
}

/**
 * Measure a candidate criterion against titles this client has actually sourced.
 *
 * Returns the sanity result and the status the criterion should carry. Called at
 * derivation time, before the criterion is stored, so an out-of-band criterion is
 * never the thing an operator discovers from an empty pipeline a week later.
 */
export function checkSanityBand(
  criterion: BuyerCriterion,
  sampleTitles: string[],
): { status: BuyerCriterion['status']; sanity: BuyerCriterionSanity } {
  const distinct = Array.from(new Set(
    sampleTitles.filter(t => typeof t === 'string' && t.trim() !== '').map(t => t.trim()),
  ))

  if (distinct.length < MIN_SANITY_SAMPLE) {
    return {
      status: criterion.status,
      sanity: {
        checked: false,
        sample_size: distinct.length,
        accept_rate: null,
        note:
          `Not checked: ${distinct.length} distinct sourced titles available, ` +
          `${MIN_SANITY_SAMPLE} needed. The criterion is stored unmeasured.`,
      },
    }
  }

  // Evaluate against a copy forced to `derived`, so the band measures the criterion
  // itself rather than the status it happens to arrive with.
  const asDerived: BuyerCriterion = { ...criterion, status: 'derived' }
  const accepted = distinct.filter(
    title => evaluateBuyerCriterion(asDerived, title).decision === 'accept',
  ).length
  const rate = accepted / distinct.length

  if (rate < MIN_ACCEPT_RATE || rate > MAX_ACCEPT_RATE) {
    return {
      status: 'out_of_band',
      sanity: {
        checked: true,
        sample_size: distinct.length,
        accept_rate: rate,
        note:
          `Out of band: accepts ${accepted} of ${distinct.length} sourced titles ` +
          `(${(rate * 100).toFixed(1)}%), outside ${MIN_ACCEPT_RATE * 100}% to ` +
          `${MAX_ACCEPT_RATE * 100}%. Not applied. Needs an operator decision.`,
      },
    }
  }

  return {
    status: criterion.status,
    sanity: {
      checked: true,
      sample_size: distinct.length,
      accept_rate: rate,
      note: `Accepts ${accepted} of ${distinct.length} sourced titles (${(rate * 100).toFixed(1)}%).`,
    },
  }
}
