// The three fields synthesis hands the writer: the candidates, the one it selected, and why
// its material was judged relevant.
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
  synthesis: Pick<SynthesisOutput, 'candidates' | 'selected_candidate_id' | 'relevance_reason'>,
): Pick<ProduceOpeningInput, 'candidates' | 'selectedCandidateId' | 'relevanceReason'> {
  return {
    candidates: synthesis.candidates,
    selectedCandidateId: synthesis.selected_candidate_id,
    relevanceReason: synthesis.relevance_reason,
  }
}
