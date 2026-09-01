// Counts question marks on the email that ACTUALLY SHIPS, after composition.
//
// ─── THE GAP THIS CLOSES ─────────────────────────────────────────────────────
//
// The house rule is one question mark per email body: the CTA is the question, and a
// second one splits the ask. It is enforced in two places, and NEITHER of them reads a
// composed email:
//
//   1. validateEmails in the messaging agent, on the STORED DOCUMENT body at generation
//      time. It never sees a prospect, a researched opening or a written CTA.
//   2. checkOpeningGates in write-opening.ts, on the WRITER'S OWN BLOCK, meaning the
//      observation, the bridge and the written question joined together. It never sees the
//      paragraphs the document contributes around them.
//
// Composition builds the shipped email out of both sources. So a question mark from the
// document and a question mark from the writer each pass their own gate, and the email
// carrying both is checked by nothing. Every existing check runs upstream of the join.
//
// ─── MEASURED 2026-09-01 ─────────────────────────────────────────────────────
//
// The 24 stored prospects, composed through the real production path against every
// messaging document their organisation has ever had:
//
//   under all five ACTIVE + APPROVED documents      0 of 24 flagged
//   under the archived document dated 2026-08-07    4 of 24 flagged
//
// The four are exactly the four prospects on the variant whose Email 1 carries a second
// question of its own, above the CTA. That document was authored before validateEmails
// enforced the rule at generation time, so it is a document the current generator would
// reject and an older stored one that nothing re-checks.
//
// This gate would therefore have flagged nothing today and four emails historically. That
// is the argument for shipping it report-only rather than the argument against shipping
// it: the count is zero because the active documents happen to be well-formed, not because
// anything is checking them.
//
// ─── THE FOOTER IS STRIPPED FIRST, AND THAT IS LOAD-BEARING ──────────────────
//
// The opt-out footer is appended at composition and CONTAINS A QUESTION MARK. Counting the
// raw composed body would therefore report at least one question on every email ever sent,
// and exactly two on every correct one. A gate that fires on every input is an outage, not
// a control. The footer is a legal notice rather than copy, it is excluded from every word
// budget for the same reason, and it is excluded here on the same grounds.
//
// Deterministic (ADR-018). No model call.

import { logger } from '@/lib/logger'
import { OPT_OUT_FOOTER } from '@/lib/composition/opt-out-footer'

// REPORT-ONLY FIRST, following the pattern in sentence-initial-names.ts and for the same
// reason: a gate nobody has watched fire is a gate nobody has tested.
//
// A CONSTANT, NOT A DATE. This file does not roll over on its own. An automatic flip would
// put the gate into blocking mode without anyone having read what it caught, which is the
// only thing an observation period is for.
//
// WHAT BLOCKING WOULD MEAN HERE, because it is not the same as the writer gates. This runs
// at the END of composition, on a finished email, with no attempt left to retry and
// nothing upstream to hand the failure back to. So 'block' must mean the send is refused
// for that prospect, not that a rewrite is requested. That is a heavier consequence than a
// writer gate carries, and it is a second reason not to flip it without evidence.
//
// TO FLIP: change this to 'block', decide and implement what the caller does with a
// non-empty return, and record in BACKLOG what the observation period showed.
export type ComposedQuestionGateMode = 'report' | 'block'
export const COMPOSED_QUESTION_GATE_MODE: ComposedQuestionGateMode = 'report'

/** Review date, for the BACKLOG entry and for whoever finds this later. */
export const COMPOSED_QUESTION_GATE_REVIEW_AFTER = '2026-10-01'

/**
 * The limit, stated here rather than imported from the messaging agent.
 *
 * DELIBERATELY A SEPARATE CONSTANT. MAX_QUESTIONS_PER_EMAIL governs the stored document,
 * which has no footer and no written CTA; this governs a composed email, which has both.
 * They agree on the number today and they are not the same rule, so importing one into the
 * other would make a future change to either silently change the other.
 */
export const MAX_QUESTIONS_PER_COMPOSED_EMAIL = 1

/** The composed body with the opt-out footer removed. Exported for tests. */
export function bodyWithoutOptOutFooter(body: string): string {
  return body.split(OPT_OUT_FOOTER).join('')
}

/** Question marks in the shipped copy, footer excluded. Pure. Exported for tests. */
export function countComposedQuestions(body: string): number {
  return (bodyWithoutOptOutFooter(body).match(/\?/g) ?? []).length
}

/**
 * Runs the check and logs an over-limit composed email with the prospect and the count.
 *
 * Returns the failure strings for a caller to act on, which is EMPTY in report mode. That
 * is the whole of the report-only behaviour: the hit is logged either way, and only a
 * blocking mode turns it into something that stops a send.
 */
export function checkComposedQuestionCount(
  body: string,
  context: { prospectId: string; clientId: string; variantId: string },
  /**
   * Defaulted to the module constant, which is what production uses. A PARAMETER ONLY SO
   * THE BLOCKING PATH CAN BE EXECUTED BY A TEST while the constant says 'report'. A flip
   * that has never been run is a flip nobody has tested. Production never passes this.
   */
  mode: ComposedQuestionGateMode = COMPOSED_QUESTION_GATE_MODE,
): string[] {
  const count = countComposedQuestions(body)
  if (count <= MAX_QUESTIONS_PER_COMPOSED_EMAIL) return []

  logger.warn('composed-question-gate: composed Email 1 asks more than one question', {
    ...context,
    mode,
    count,
    limit: MAX_QUESTIONS_PER_COMPOSED_EMAIL,
  })

  if (mode !== 'block') return []

  return [
    `composed Email 1 contains ${count} question marks, limit is ` +
    `${MAX_QUESTIONS_PER_COMPOSED_EMAIL}. The closing CTA is the only question. The ` +
    `opt-out footer is excluded from this count.`,
  ]
}
