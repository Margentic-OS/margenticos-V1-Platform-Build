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
    supportingCandidateId: synthesis.supporting_candidate_id ?? null,
  }
}
