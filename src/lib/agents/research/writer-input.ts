// The six fields synthesis hands the writer: the candidates, the one it selected, why its
// material was judged relevant, why that candidate beat the runner-up, why the prospect has
// a reason at all, and a second event supporting that reason.
//
// ONE MAPPING FOR EVERY CALLER: the inline agent, phase 2 of the batch path and
// scripts/export-writer-run.ts. Three call sites spelling it out separately is how the export
// came to pass the candidates alone and measure a thinner handover than production for two
// days (found 2026-09-11). A field added here reaches all three or none.
//
// ITS OWN MODULE, importing only types, so a test that mocks produce-opening still runs this
// real mapping rather than a stand-in for it.

import type { ProduceOpeningInput } from './produce-opening'
import type { SynthesisOutput } from './types'

export function writerInputFromSynthesis(
  synthesis: Pick<SynthesisOutput, 'candidates' | 'selected_candidate_id' | 'relevance_reason'> &
    Partial<Pick<SynthesisOutput, 'selection_reason' | 'prospect_reason' | 'supporting_candidate_id'>>,
): Pick<ProduceOpeningInput, 'candidates' | 'selectedCandidateId' | 'relevanceReason' | 'selectionReason' | 'prospectReason' | 'supportingCandidateId'> {
  return {
    candidates: synthesis.candidates,
    selectedCandidateId: synthesis.selected_candidate_id,
    relevanceReason: synthesis.relevance_reason,
    // OPTIONAL ON THE INPUT, not on the output. A caller that predates the field passes a
    // synthesis without it and gets null, which is what a run that recorded no choice looks
    // like. Required here would have meant every test fixture growing a field to say nothing.
    selectionReason: synthesis.selection_reason ?? null,
    prospectReason: synthesis.prospect_reason ?? null,
    supportingCandidateId: supportingIfSameTrigger(synthesis),
  }
}

/**
 * A SUPPORTING EVENT SURVIVES ONLY IF IT IS AN INSTANCE OF THE SAME TRIGGER AS THE MAIN ONE.
 *
 * The writer is told a supporting event "points at the same reason" and may name both in one
 * sentence. That is only true when the two events are instances of the same thing. Synthesis
 * checks that the supporting candidate is real, different and eligible (synthesize.ts), but
 * never that it is ABOUT the same reason, so a second unrelated fact was reaching the writer
 * with an instruction saying it belonged to the first. Measured on the 104 cohort on
 * 2026-09-25: 25 prospects carried a supporting event and 16 of them had no shared trigger.
 *
 * `!= null` ON BOTH SIDES, and it is the whole rule. A null matched_trigger means "matched
 * none of this client's triggers", which is a legitimate, common state and NOT a rejection.
 * Two candidates that each matched nothing have not matched each other, so `null === null`
 * must not read as agreement. Using `!==` against undefined would do exactly that, because a
 * row written before 2026-09-23 has the key absent rather than null.
 *
 * HERE AND NOT IN synthesize.ts, deliberately. The stored id is a frozen verdict (ADR-034):
 * a reuse run loads supporting_candidate_id straight off the row and never re-derives it, so
 * a fix at derivation time would change nothing for any prospect already researched. This
 * module is the single mapping every caller goes through, including the reuse path, which is
 * what makes one edit sufficient.
 */
function supportingIfSameTrigger(
  synthesis: Pick<SynthesisOutput, 'candidates' | 'selected_candidate_id'> &
    Partial<Pick<SynthesisOutput, 'supporting_candidate_id'>>,
): string | null {
  const supportingId = synthesis.supporting_candidate_id ?? null
  if (supportingId === null) return null

  const triggerOf = (id: string | null) =>
    id === null ? null : synthesis.candidates.find(c => c.id === id)?.matched_trigger ?? null

  const main = triggerOf(synthesis.selected_candidate_id ?? null)
  const supporting = triggerOf(supportingId)

  return main != null && supporting != null && main === supporting ? supportingId : null
}
