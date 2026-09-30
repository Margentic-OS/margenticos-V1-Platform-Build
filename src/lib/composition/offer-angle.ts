// WHICH OFFER LINE A RESEARCHED EMAIL 1 SHOULD CARRY.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE 2026-09-30 OPERATOR READ. Six of twenty blind-marked Email 1s drew the same
// complaint, which was the most frequent single fault in that file and appeared in BOTH
// arms of the A/B at the same rate:
//
//   "for the offer line, the pain point and personalization are not about current work so
//    that's not what should be focused on"
//   "The offer line is talking about current work again, which wasn't relevant to the
//    personalization or the pain point, so potentially a fail"
//   "again no point mentioning the founder being in delivery when that's not the pain point"
//   "it references the founder being in delivery, which was not relevant to the
//    personalization or the pain point in the offer line"
//
// ─── THE STRUCTURAL CAUSE, WHICH IS NOT THE COPY ─────────────────────────────
//
// The variant, and therefore the offer line, is chosen by a HASH OF THE PROSPECT ID. The
// hook is chosen by research from what that prospect actually did. The two are independent
// by construction, so the fraction of prospects whose offer line happens to answer their
// hook is whatever chance gives it. No amount of rewriting the four offer lines changes
// that, because the fault is the pairing rather than either side of it.
//
// AND THE FOUR VARIANT ANGLES DO NOT HELP. VARIANT_ANGLE_INSTRUCTIONS describes how each
// variant's Email 1 OPENS: pain-led, outcome-led, peer pattern, pattern interrupt. On the
// researched path that opening paragraph is REPLACED. So the one thing distinguishing the
// variants is the paragraph personalisation deletes, and what survives, the offer line and
// the CTA, is what nothing chooses by fit.
//
// ─── WHY THE TAG HAS TO BE EXPLICIT ──────────────────────────────────────────
//
// Deriving the pairing from the text was tried first and measured at zero. contentOverlap
// between three real hook shapes and two real offer lines scored 0.000 on all six pairs,
// which is not a tuning problem: an offer line is about what the SENDER does and a hook is
// about what the PROSPECT did, so they share no content word by design. A deterministic
// derivation has nothing to read.
//
// So each variant's Email 1 declares the pain its offer line answers, and one variant
// declares none. Per ADR-018 the SELECTION stays deterministic; only the tagging is model
// work, and it happens once per document rather than once per prospect.
//
// ─── WHAT HAPPENS ON A DOCUMENT THAT CARRIES NO TAGS ─────────────────────────
//
// Exactly what happens today: the assigned variant keeps its own offer line. The field is
// optional and absence is not a failure. Code deploys globally and messaging documents are
// per-client data, so the two can never be switched in the same instant, and a selector that
// required tags would strand every client until their document was next regenerated. Same
// reasoning as EMAIL1_FRAME_SLOT_PARAGRAPHS accepting both slot shapes, permanently.
// ═════════════════════════════════════════════════════════════════════════════

import { stableHash } from './variant-assignment'

/**
 * The pain a variant's Email 1 offer line answers, as that variant declares it.
 *
 * A NEUTRAL LINE IS `null`, NOT A KEYWORD. "neutral", "none" and "general" are all things a
 * model will write when it means "I could not decide", and a sentinel string cannot tell
 * that apart from a deliberate choice. Absence can only mean absence.
 */
export interface OfferAngleCandidate {
  variantId: string
  /** The pain this variant's offer line names, or null when it names none. */
  offerAngle: string | null
}

/**
 * How much of the hook's content must be shared with a declared angle before that variant's
 * offer line counts as answering it.
 *
 * ═══ THIS FLOOR IS DELIBERATELY TOO HIGH, AND THE ASYMMETRY IS WHY ═══
 *
 * Measured 2026-09-30 on two hook-and-angle pairs written to be genuine matches. A hiring
 * hook against a hiring angle scored 0.429 because the two share a literal phrase. A content
 * hook against a content angle scored 0.167, BELOW this floor, because the only word they
 * share is "published". Both non-matching pairs scored 0.000.
 *
 * So lexical overlap does discriminate here, by a wide ratio, but its absolute magnitude is
 * not something two invented fixtures can set. The real figure needs real angles, and no
 * client document carries one yet.
 *
 * THE COST OF BEING WRONG IS NOT SYMMETRIC, which is what settles it without the measurement:
 *
 *   floor TOO HIGH  a real match falls through to the NEUTRAL line. A line naming no specific
 *                   pain cannot name the wrong one, so the email is correct and merely less
 *                   pointed than it could have been.
 *   floor TOO LOW   a weak match wins and the prospect gets a line about a pain they do not
 *                   have. That is precisely the fault this file exists to remove, reintroduced
 *                   by the mechanism meant to fix it.
 *
 * A gate whose failure mode is "safe but unambitious" should be set on the safe side until
 * measured. So this keeps the event matcher's 0.20 and accepts that a match at 0.167 is
 * treated as no match.
 *
 * WHOEVER SHIPS THE FIRST TAGGED DOCUMENT: measure this against real angles and real hooks
 * before trusting it, and record the date and the figure here. Until then a document with
 * tags will route more prospects to the neutral line than it needs to.
 */
export const ANGLE_MATCH_FLOOR = 0.20

/**
 * A winner must also beat the field, not merely clear the floor.
 *
 * Same shape and same value as the event matcher's relative rule, and for the same reason
 * given there: a set of uniformly weak scores must not elect a winner by default. Here it
 * matters more than it does there, because a hook and an angle describe one problem in two
 * vocabularies, so scores sit low and the gap between "about this" and "not about this" is
 * proportional rather than absolute.
 */
export const ANGLE_MATCH_RELATIVE = 0.5

export type OfferLineChoice =
  | { variantId: string; basis: 'angle_match'; score: number }
  | { variantId: string; basis: 'neutral' }
  | { variantId: string; basis: 'no_tags' }
  | { variantId: string; basis: 'no_match_no_neutral' }

/**
 * The variant whose offer line best answers this hook.
 *
 * In order:
 *   1. the highest-scoring variant whose declared angle the hook reaches,
 *   2. otherwise a variant that declares no specific pain,
 *   3. otherwise the variant already assigned, unchanged.
 *
 * `basis` IS RETURNED RATHER THAN LOGGED HERE. This is a pure function called from two
 * places, and a caller that cannot see why it got the answer it got cannot record it on the
 * row. The operator's complaint was invisible for weeks precisely because no column said
 * which offer line a prospect got or why.
 *
 * TIES BREAK BY THE PROSPECT HASH, not by variant order. Two variants declaring the same
 * angle would otherwise send every matching prospect to whichever sorts first, which
 * collapses a four-variant document to one for that whole angle and does it silently.
 */
export function chooseOfferLineVariant(
  hookText: string,
  assignedVariantId: string,
  candidates: ReadonlyArray<OfferAngleCandidate>,
  prospectId: string,
  overlap: (a: string, b: string) => number,
): OfferLineChoice {
  const tagged = candidates.filter(c => c.offerAngle !== null && c.offerAngle.trim() !== '')
  const neutral = candidates.filter(c => c.offerAngle === null || c.offerAngle.trim() === '')

  // A document where NO variant declares anything is a document written before this field
  // existed. Nothing to choose from is not a failure.
  if (tagged.length === 0 && neutral.length === candidates.length) {
    return { variantId: assignedVariantId, basis: 'no_tags' }
  }

  if (hookText.trim()) {
    const scored = tagged
      .map(c => ({ c, score: overlap(hookText, c.offerAngle!) }))
      .filter(s => s.score >= ANGLE_MATCH_FLOOR)
      .sort((a, b) => b.score - a.score || a.c.variantId.localeCompare(b.c.variantId))

    if (scored.length > 0) {
      const best = scored[0].score
      // BEAT THE FIELD, not just the floor. Everything within half of the best score is
      // treated as indistinguishable from it, which is the tie set below.
      const tied = scored.filter(s => s.score >= best * ANGLE_MATCH_RELATIVE)
      const pick = tied[Math.abs(stableHash(prospectId)) % tied.length]
      return { variantId: pick.c.variantId, basis: 'angle_match', score: best }
    }
  }

  // NO MATCH MEANS THE NEUTRAL LINE, WHICH IS THE WHOLE POINT OF HAVING ONE. A line naming
  // no specific pain cannot name the wrong one, so it is strictly better than a mismatched
  // line and strictly worse than a matched one.
  if (neutral.length > 0) {
    const pick = neutral[Math.abs(stableHash(prospectId)) % neutral.length]
    return { variantId: pick.variantId, basis: 'neutral' }
  }

  // Every variant declares a pain and none of them is this prospect's. Keeping the assigned
  // variant is the honest outcome: there is no better offer line in this document, and
  // refusing to personalise over it would cost a good email to fix a copy gap.
  return { variantId: assignedVariantId, basis: 'no_match_no_neutral' }
}
