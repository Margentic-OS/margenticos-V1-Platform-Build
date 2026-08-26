// THE SINGLE SOURCE OF TRUTH FOR SEND ELIGIBILITY.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE PROBLEM THIS SOLVES
//
// prospects.email_send_eligible is MATERIALISED: it is written once, at verification time,
// and read at send time as the last word. That was workable with one verifier, because one
// pass wrote it and nothing else could disagree.
//
// A second verifier breaks it. Two passes now write the same column, so its value depends on
// WHICH PASS RAN LAST rather than on what the evidence says. Worse, the policy that computes
// it was written out longhand inside verification-trigger.ts:
//
//     email_send_eligible: eligibilityCheck.is_eligible && result.send_eligible
//
// with `result.send_eligible` computed separately inside the vendor handler as
// `status === 'Valid' && !catch_all`. Adding a second pass by copying that expression would
// have produced two policies that agree today and drift silently later.
//
// So the column STAYS materialised, because the send gate is right to want one fast flat
// read, and it is only ever written from this one function. One policy, one place, both
// callers.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE DISAGREEMENT RULE, approved by Doug 2026-08-25
//
//   first pass deliverable                  -> ELIGIBLE. No second pass is run or needed.
//   first pass undeliverable                -> INELIGIBLE, and the second pass cannot
//                                              overturn it. "Invalid" is a POSITIVE finding
//                                              that the mailbox does not exist, not a
//                                              failure to reach a verdict. A second opinion
//                                              does not resurrect a dead mailbox, and we do
//                                              not spend a paid call asking.
//   first pass risky/unknown + 2nd deliverable -> ELIGIBLE. This is the entire build.
//   first pass risky/unknown + 2nd risky     -> INELIGIBLE. Risky is where we started.
//   first pass risky/unknown + 2nd anything else, or no second pass -> INELIGIBLE.
//   never verified                           -> INELIGIBLE.
//
// Country exclusion is a hard AND over all of the above. It can only ever REMOVE
// eligibility, never grant it.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THE GATE IS THE STATUS AND NOT THE SCORE
//
// Bouncer returns a 0-100 score alongside its verdict. On the 2026-08-25 sample the eight
// deliverable addresses all scored 90 and the two risky ones scored 75 and 15, which looks
// like an obvious threshold sitting somewhere around 80.
//
// It is not taken, deliberately. n=10 on a single day, on a cohort that was entirely inside
// the vendor's stated Google/Microsoft sweet spot, cannot support a numeric cut-off: the
// whole usable range between 75 and 90 is unobserved. The status is the vendor's own
// judgement over its own evidence and is what its documentation defines. The score is
// RECORDED on every prospect so that a threshold can be derived later from real data, and
// gated on by nothing.

import { checkSendEligibility } from '@/lib/sourcing/send-eligibility-rules'
import type { CanonicalVerdict } from '@/lib/sourcing/verification-verdict'

export interface SendEligibilityInput {
  country: string | null
  email: string | null
  /** Canonical verdict from the cheap whole-list pass. null means never verified. */
  firstPass: CanonicalVerdict | null
  /** Canonical verdict from the paid second pass. null means it has not run. */
  secondPass: CanonicalVerdict | null
}

export interface SendEligibilityDecision {
  eligible: boolean
  /**
   * The value for prospects.email_send_ineligible_reason.
   *
   * NON-VERIFICATION REASONS ONLY, and null whenever the block is a verification verdict.
   * This is not an oversight. checkResearchEligibility treats any non-null value in that
   * column as a country exclusion (send-eligibility-policy.ts), because that is the only
   * thing that has ever been written there. Widening it here without changing that reader
   * would make every catch-all report as "excluded country" in the operator's skip summary.
   *
   * The verification half of the reason is already fully recoverable from
   * independent_email_status and second_pass_status, so nothing is lost by not duplicating
   * it into a column whose meaning is load-bearing elsewhere.
   */
  ineligibleReason: string | null
  /** Human-readable explanation for logs and operator surfaces. Never stored. */
  detail: string
}

export function resolveSendEligibility(input: SendEligibilityInput): SendEligibilityDecision {
  // ── Country first, because it is a hard commercial rule that no verdict can override ──
  //
  // Evaluated BEFORE the verdicts on purpose. This is the gate that failed silently until
  // 2026-08-25 and let two German prospects be mailed, and it is the one whose cost of being
  // wrong is legal rather than commercial. It is also the reason the second pass could not
  // safely run until prospects.country was populated and canonical: a German catch-all
  // resolved to deliverable would otherwise come back send-eligible with this never
  // consulted. See src/lib/sourcing/country-code.ts.
  const country = checkSendEligibility(input.country, input.email)
  if (!country.is_eligible) {
    return {
      eligible: false,
      ineligibleReason: country.reason,
      detail: `Excluded on jurisdiction (${country.reason}). No verification verdict changes this.`,
    }
  }

  if (input.firstPass === null) {
    return {
      eligible: false,
      ineligibleReason: null,
      detail: 'Never verified. The first pass has not run on this address.',
    }
  }

  if (input.firstPass === 'deliverable') {
    return {
      eligible: true,
      ineligibleReason: null,
      detail: 'First pass confirmed the mailbox accepts mail.',
    }
  }

  if (input.firstPass === 'undeliverable') {
    // A second-pass verdict is reported if one somehow exists, but it does not change the
    // answer. Stated explicitly so a future reader does not mistake this for an oversight.
    return {
      eligible: false,
      ineligibleReason: null,
      detail:
        'First pass confirmed the mailbox does not exist. A second opinion cannot overturn ' +
        'a positive undeliverable finding' +
        (input.secondPass ? `, and the second pass returned "${input.secondPass}".` : '.'),
    }
  }

  // firstPass is 'risky' or 'unknown': reachable but unconfirmed. This is the segment the
  // paid second pass exists to resolve.
  if (input.secondPass === null) {
    return {
      eligible: false,
      ineligibleReason: null,
      detail:
        `First pass returned "${input.firstPass}", which cannot confirm the mailbox. ` +
        'The second pass has not run on this address yet.',
    }
  }

  if (input.secondPass === 'deliverable') {
    return {
      eligible: true,
      ineligibleReason: null,
      detail:
        `First pass returned "${input.firstPass}"; the second pass resolved the address to ` +
        'deliverable. Provider-specific resolution is strictly more information than an ' +
        'SMTP probe against a domain that accepts everything.',
    }
  }

  return {
    eligible: false,
    ineligibleReason: null,
    detail:
      `First pass returned "${input.firstPass}" and the second pass returned ` +
      `"${input.secondPass}". Neither confirms the mailbox, so nothing has been gained.`,
  }
}
