// The reason a personalised opening argues from is the one the client APPROVED.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE RULE (operator note 5 on the second reading, 2026-10-01)
//
// Personalisation is used for what the event implies about the prospect's goal, per the
// approved big-picture trigger reasons. A firm that posts a client-facing role is a firm
// that wants to grow: the hire is evidence of the goal, and the goal is what the email is
// about.
//
// Each of the client's triggers carries a reason the operator approved, in the client's ICP
// (tier_1.triggers[].reason): why this KIND of event matters. That sentence is the
// implication. It is written once, checked once, and true of every firm the event happens
// to.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT WAS HAPPENING INSTEAD
//
// Synthesis wrote its OWN sentence for each prospect, was told not to repeat the approved
// principle, and code never compared the two. It also wrote one when the chosen fact
// matched no trigger at all. So the "reason" the writer argued from was the approved one in
// 2 of 56 personalised openings measured on the live client (24 September to 1 October), a
// model's paraphrase in 46, and in 10 it had no approved reason behind it whatsoever.
//
// The paraphrases drift the same way every time: from what the event says about the firm's
// direction to a task the reader is told they now have. "Hiring points to growth" became
// "every new account manager needs a full client book waiting on their first day", which
// is a guess about somebody's diary.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT THIS MODULE DECIDES, AND IT IS DETERMINISTIC
//
// Given the candidates, the one research selected, and the client's trigger list:
//
//   approved               the selected fact matched a trigger that carries a reason. The
//                          writer argues from THAT sentence, verbatim.
//   no_selection           research recorded no selected fact, so nothing says which
//                          trigger the opening would rest on.
//   no_trigger_matched     the selected fact matched none of the client's triggers.
//   trigger_has_no_reason  it matched one whose reason was never written.
//   outside_definition     (set by produce-opening, 2026-10-03) the matched trigger carries
//                          a definition and the selected fact is not within it, or the
//                          reading could not be used. See trigger-definition.ts.
//   not_checked            the client has no trigger carrying a reason at all, or the
//                          caller supplied no list. The rule cannot be applied, and is not:
//                          withholding every opening from a client because their ICP
//                          predates the reason field would be a pipeline stop for a missing
//                          input.
//
// The middle states HOLD personalisation: no opening is written, and the prospect
// goes down the ladder to a line about what their firm does, or to the template. A
// personalised opening with no approved implication behind it is a fact followed by a
// guess.

import type { ObservationCandidate } from './types'

/** One of the client's triggers. Structurally the same as synthesize.ts's ClientTrigger. */
export interface TriggerWithReason {
  trigger: string
  reason: string
  /**
   * WHAT COUNTS AS THIS EVENT AND WHAT DOES NOT, in the client's words (added 2026-10-03).
   * Plain sentences, approved with the ICP like the reason.
   *
   * WHY. A trigger is a short line, and a short line is read generously. "A job is posted
   * for a delivery or client-facing role" fired on a blog post introducing a new team
   * member whose role nobody checked, and on a marketing hire, which is not a delivery hire.
   * The reason said what the event means; nothing said what the event IS. See
   * trigger-definition.ts for the check that reads a fact against it.
   *
   * ABSENT MEANS TODAY'S BEHAVIOUR EXACTLY: no check, no call, no cost. Loaders add the key
   * only when the document carries a non-empty definition.
   */
  definition?: string
}

export type ApprovedReason =
  | { state: 'approved'; reason: string; trigger: string; triggerIndex: number; definition?: string }
  | { state: 'no_selection' }
  | { state: 'no_trigger_matched' }
  | { state: 'trigger_has_no_reason'; triggerIndex: number }
  | { state: 'not_checked'; why: 'no_trigger_list' | 'no_trigger_has_a_reason' }
  /**
   * The fact matched a trigger with an approved reason, and that trigger's definition was
   * read against it: the fact is outside it ('outside'), or the reading could not be used
   * ('unusable', which holds too: an unchecked fact is the thing this state exists to stop).
   * `why` is the model's own sentence, or what went wrong with the reading. Never returned
   * by resolveApprovedReason, which is deterministic; set by produce-opening after the check.
   */
  | { state: 'outside_definition'; trigger: string; triggerIndex: number; verdict: 'outside' | 'unusable'; why: string }

/** The states that hold personalisation. One list, read by the gate and by its tests. */
export const HOLDING_STATES = ['no_selection', 'no_trigger_matched', 'trigger_has_no_reason', 'outside_definition'] as const
export type HoldingState = (typeof HOLDING_STATES)[number]

export function holdsPersonalisation(approved: ApprovedReason): approved is Extract<ApprovedReason, { state: HoldingState }> {
  return (HOLDING_STATES as readonly string[]).includes(approved.state)
}

/**
 * The approved reason for the fact research selected.
 *
 * `matched_trigger` on a candidate is the 1-based position of the trigger in the client's
 * list AS IT STOOD WHEN SYNTHESIS RAN, and `matched_trigger_text` is that trigger's wording
 * at the time. The list handed to this function is not always that list:
 *
 *   - the batch path passes the snapshot synthesis used, so they agree;
 *   - the inline path reads the client's documents a SECOND time after synthesis returns,
 *     so an ICP promoted between the two reads can differ;
 *   - a run that reuses stored findings resolves a position recorded days earlier against
 *     the list as it stands today.
 *
 * So the position is CHECKED against the wording wherever the wording was recorded:
 *
 *   wording matches at that position   that trigger's reason, as it reads TODAY. A reason
 *                                      the operator has since reworded is the one to use.
 *   wording found at another position  the list was reordered; the trigger is followed to
 *                                      where it now sits.
 *   wording found nowhere              the trigger was removed or rewritten. The match no
 *                                      longer holds: no_trigger_matched, and no opening.
 *
 * THE LIMIT, STATED. A candidate stored before 2026-10-01 carries no wording and is
 * resolved by position alone. On the live client the list kept its eleven triggers in the
 * same order across four ICP versions, so those rows resolve correctly today; a reordered
 * list would hand them another trigger's reason, and nothing detects it. They age out of
 * the 30-day reuse window.
 */
export function resolveApprovedReason(
  candidates: ReadonlyArray<Pick<ObservationCandidate, 'id' | 'matched_trigger' | 'matched_trigger_text'>>,
  selectedCandidateId: string | null | undefined,
  triggers: ReadonlyArray<TriggerWithReason> | null | undefined,
): ApprovedReason {
  if (!triggers || triggers.length === 0) return { state: 'not_checked', why: 'no_trigger_list' }
  if (!triggers.some(t => typeof t.reason === 'string' && t.reason.trim() !== '')) {
    return { state: 'not_checked', why: 'no_trigger_has_a_reason' }
  }
  if (!selectedCandidateId) return { state: 'no_selection' }
  const selected = candidates.find(c => c.id === selectedCandidateId)
  if (!selected) return { state: 'no_selection' }

  let index = selected.matched_trigger
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 1) return { state: 'no_trigger_matched' }

  const wording = typeof selected.matched_trigger_text === 'string' ? selected.matched_trigger_text.trim() : ''
  if (wording) {
    if (triggers[index - 1]?.trigger.trim() !== wording) {
      const moved = triggers.findIndex(t => t.trigger.trim() === wording)
      if (moved === -1) return { state: 'no_trigger_matched' }
      index = moved + 1
    }
  } else if (index > triggers.length) {
    return { state: 'no_trigger_matched' }
  }

  const trigger = triggers[index - 1]
  const reason = typeof trigger.reason === 'string' ? trigger.reason.trim() : ''
  if (!reason) return { state: 'trigger_has_no_reason', triggerIndex: index }
  // THE DEFINITION TRAVELS WITH THE MATCH, and only when there is one. No key at all
  // otherwise, so a client without definitions resolves to exactly what it did before.
  const definition = typeof trigger.definition === 'string' ? trigger.definition.trim() : ''
  return definition
    ? { state: 'approved', reason, trigger: trigger.trigger, triggerIndex: index, definition }
    : { state: 'approved', reason, trigger: trigger.trigger, triggerIndex: index }
}

/**
 * The sentence the Email 1 writer AND the follow-up writer argue from: the approved reason
 * where there is one, and otherwise whatever reason the caller already had.
 *
 * ONE FUNCTION, because there are two callers and they drifted on the day the rule was
 * written. The research path handed its follow-up writer the approved sentence; the
 * follow-up backfill, which is the route every held prospect goes through, still handed
 * its writer the sentence synthesis had stored. Where the rule is not applied the fallback
 * passes through untouched, undefined included.
 */
export function reasonTheWritersArgueFrom<T extends string | null | undefined>(approved: ApprovedReason, fallback: T): string | T {
  return approved.state === 'approved' ? approved.reason : fallback
}
