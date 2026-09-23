// THE HANDOVER. Synthesis choosing well is worth nothing if the choice and the reason for it
// do not reach the writer, which is exactly what happened on 2026-09-11: the selection was
// correct on the row and the writer never saw it for twelve days, with green tests on both
// ends the whole time. These tests are about the SEAM.

import { describe, it, expect } from 'vitest'
import { writerInputFromSynthesis } from '../writer-input'
import { buildFindingsBlock } from '../write-opening'
import type { ObservationCandidate, SynthesisOutput } from '../types'

function candidate(over: Partial<ObservationCandidate>): ObservationCandidate {
  return {
    id: 'c1',
    observation: 'You published a piece on procurement in March.',
    source: 'linkedin',
    provenance: 'https://example.com/post',
    date: '2026-03-04',
    is_composite: false,
    scores: {
      specific: true, verifiable: true, inferential: true,
      relevant: true, useful: true, non_judgemental: true,
    },
    passes_all: true,
    score_total: 6,
    model_readable_claim: true,
    opposite_reading: 'They could have published it for recruiting reasons.',
    inference_direction: 'compatible_with_both',
    readability: {
      hard_fail: false, penalty: 0, max_sentence_words: 8, hedges: [],
      nominalisation_density: 0, nominalisation_over_threshold: false, reasons: [],
    },
    demoted: false,
    rejection_reason: null,
    ...over,
  }
}

describe('the selection reason reaches the writer', () => {
  it('writerInputFromSynthesis carries it, because that mapping is what every caller uses', () => {
    const input = writerInputFromSynthesis({
      candidates: [candidate({})],
      selected_candidate_id: 'c1',
      relevance_reason: 'They sell to the same buyer.',
      selection_reason: 'Chose c1, nine days old, over c2 from nine months ago.',
    } as Pick<SynthesisOutput, 'candidates' | 'selected_candidate_id' | 'relevance_reason' | 'selection_reason'>)
    expect(input.selectionReason).toBe('Chose c1, nine days old, over c2 from nine months ago.')
  })

  it('a caller passing no selection reason gets null, not undefined or a crash', () => {
    const input = writerInputFromSynthesis({
      candidates: [candidate({})],
      selected_candidate_id: 'c1',
      relevance_reason: 'R',
    })
    expect(input.selectionReason).toBeNull()
  })

  it('the findings block prints it under WHY THIS ONE', () => {
    const block = buildFindingsBlock([candidate({})], {
      selectedCandidateId: 'c1',
      relevanceReason: 'They sell to the same buyer.',
      selectionReason: 'Chose c1 over c2 because it is six weeks old against six months.',
    })
    expect(block).toContain('WHY THIS ONE: Chose c1 over c2 because it is six weeks old against six months.')
  })

  it('and prints nothing at all when there was no choice, rather than a line saying so', () => {
    const block = buildFindingsBlock([candidate({})], {
      selectedCandidateId: 'c1',
      relevanceReason: 'They sell to the same buyer.',
      selectionReason: null,
    })
    expect(block).not.toContain('WHY THIS ONE')
    // POSITIVE CONTROL: the block still rendered. An assertion that something is absent
    // passes just as happily when nothing was rendered at all.
    expect(block).toContain('They sell to the same buyer.')
  })
})

describe('a reshare is marked as somebody else\'s', () => {
  it('carries [SHARED, NOT THEIRS] in the findings the writer reads', () => {
    const block = buildFindingsBlock([candidate({ is_reshare: true })], { selectedCandidateId: 'c1' })
    expect(block).toContain('[SHARED, NOT THEIRS]')
  })

  it('and their own post carries no such mark', () => {
    const block = buildFindingsBlock([candidate({ is_reshare: false })], { selectedCandidateId: 'c1' })
    expect(block).not.toContain('[SHARED, NOT THEIRS]')
    expect(block).toContain('[SELECTED BY SYNTHESIS]')
  })

  it('a stored candidate with no is_reshare field reads as their own, never as shared', () => {
    const stored = candidate({})
    delete (stored as unknown as Record<string, unknown>).is_reshare
    const block = buildFindingsBlock([stored], {})
    expect(block).not.toContain('[SHARED, NOT THEIRS]')
  })
})
