// A personalised Email 1 needs a follow-up that carries its thread forward.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE RULE (operator note 4 on the second reading, 2026-10-01)
//
// When Email 1 is personalised, Email 2 or Email 3 must be personalised too, written
// against that same Email 1. A sequence that opens on something real about the reader and
// then sends two emails that could have gone to anybody reads as a mail merge with one
// good line in it.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT WAS HAPPENING INSTEAD
//
// Nothing required it. Composition substitutes a personalised follow-up when one is stored
// and still matches Email 1, and otherwise ships the template in that position with a
// reason code. No caller read the code. Measured on the live client 2026-10-01: of 209
// prospects holding a personalised Email 1, 50 held any personalised follow-up, and all
// four personalised sequences in the second reading file had template Emails 2 and 3,
// because the research that wrote their Email 1 predates the follow-up writer.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT THIS DOES
//
// It is a verdict on a COMPOSED sequence, pure and free. The upload reads it and HOLDS a
// prospect that fails: the prospect goes back to pending with the reason recorded, and is
// not sent. scripts/backfill-followups.ts writes the missing follow-up, after which the
// same prospect composes and uploads normally.
//
// HELD, NOT DOWNGRADED. The alternative is to drop the personalised Email 1 and send the
// template. That throws away the most valuable line in the sequence to fix the least
// valuable ones, and it does it silently.
//
// WHAT A HOLD COSTS, STATED. Usually a run of the backfill. NOT ALWAYS: the backfill cannot
// write for a prospect whose research is more than 30 days old, whose variant leaves no
// follow-up to model on, or whose follow-ups the writer cannot get past their checks. The
// backfill names each of those when it runs, with what that one needs. Before this rule
// they uploaded with template follow-ups.
//
// A DIFFERENT RULE HOLDS A DIFFERENT PROSPECT: an Email 1 that was not written to one of
// the client's approved trigger reasons is held by opening-reason.ts, which the upload
// reads first. That one is never a matter for the backfill.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT IT DOES NOT COVER
//
// Only the research tier. A firm-fact Email 1 (tier 2) and a template Email 1 (tier 3) have
// no researched thread to carry, and the follow-up writer is never run for them.
//
// It also means the template ARM of the follow-up comparison (followup-assignment.ts,
// GENERATED_ARM_PERCENT) cannot be used while this rule stands: a personalised prospect
// assigned to that arm has no personalised follow-up by design and would be held. The arm
// is at 100% generated today. Lowering it is a decision to suspend this rule, and has to
// be made as one.

import type { ComposedSequence, FollowupFallbackReason } from './compose-sequence'

/** The reason code recorded on a prospect held by this rule. */
export const THREAD_NOT_CARRIED = 'personalised_without_followup'

export interface ThreadVerdict {
  /** True when the rule applies: Email 1 came from research. */
  required: boolean
  /** True when the rule is met, or does not apply. A false is a hold. */
  carried: boolean
  /** Why each follow-up position shipped as a template, or null where it was personalised. */
  reasons: { 2: FollowupFallbackReason | null; 3: FollowupFallbackReason | null }
}

export function threadVerdict(composed: Pick<ComposedSequence, 'opening' | 'followups'>): ThreadVerdict {
  const required = composed.opening.tier === 'research'
  const two = composed.followups.positions[2]
  const three = composed.followups.positions[3]
  const generated = two?.mode === 'generated' || three?.mode === 'generated'
  return {
    required,
    carried: !required || generated,
    reasons: {
      2: two?.mode === 'generated' ? null : (two?.fell_back_reason ?? 'none_stored'),
      3: three?.mode === 'generated' ? null : (three?.fell_back_reason ?? 'none_stored'),
    },
  }
}

const REASON_WORDING: Record<FollowupFallbackReason, string> = {
  not_assigned: 'this prospect is not assigned personalised follow-ups',
  none_stored: 'none has been written',
  email1_changed: 'the one on file was written against a different Email 1',
  unreadable_frame: 'the template it has to sit inside could not be read',
}

/** One sentence for the prospect's row and the operator. Names both positions. */
export function describeThreadHold(verdict: ThreadVerdict): string {
  const part = (position: 2 | 3) => {
    const reason = verdict.reasons[position]
    return `Email ${position}: ${reason ? REASON_WORDING[reason] : 'personalised'}`
  }
  return (
    `${THREAD_NOT_CARRIED}: Email 1 is personalised and neither follow-up carries it forward ` +
    `(${part(2)}; ${part(3)}). Not sent. Run the follow-up backfill, then upload again. ` +
    'The backfill names any prospect it cannot write for, with what each one needs.'
  )
}
