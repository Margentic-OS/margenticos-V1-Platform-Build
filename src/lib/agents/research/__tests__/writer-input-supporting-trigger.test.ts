// A supporting event reaches the writer only as an instance of the SAME trigger as the main
// event.
//
// WHY IT MATTERS. The writer is told the supporting event "points at the same reason" and may
// name both in one sentence. When the two events are instances of different triggers, that
// instruction is false and the copy yokes together two facts that have nothing to do with each
// other. Measured across the 104 cohort on 2026-09-25: 25 prospects carried a supporting event
// and 16 of them shared no trigger with the main one.
//
// TESTED THROUGH THE REAL MAPPING. writerInputFromSynthesis is the one function every caller
// goes through, so these assertions are about what the writer actually receives rather than
// about a helper nothing calls.
//
// RULE ZERO. Every fixture is invented and industry-neutral.

import { describe, it, expect } from 'vitest'
import { writerInputFromSynthesis } from '../writer-input'
import type { ObservationCandidate } from '../types'

function candidate(id: string, matched_trigger: number | null | undefined): ObservationCandidate {
  return {
    id,
    observation: `An invented observation for ${id}.`,
    date: '2026-06-01',
    source: 'website',
    ...(matched_trigger === undefined ? {} : { matched_trigger }),
  } as unknown as ObservationCandidate
}

function input(main: number | null | undefined, support: number | null | undefined) {
  return {
    candidates: [candidate('main', main), candidate('support', support)],
    selected_candidate_id: 'main',
    relevance_reason: 'invented',
    supporting_candidate_id: 'support',
  }
}

describe('a supporting event survives only with the same non-null trigger', () => {
  it('PASSES when both matched the SAME trigger', () => {
    expect(writerInputFromSynthesis(input(3, 3)).supportingCandidateId).toBe('support')
  })

  it('DROPS when the triggers differ', () => {
    expect(writerInputFromSynthesis(input(3, 5)).supportingCandidateId).toBeNull()
  })

  it('DROPS when the MAIN event matched no trigger', () => {
    expect(writerInputFromSynthesis(input(null, 5)).supportingCandidateId).toBeNull()
  })

  it('DROPS when the SUPPORTING event matched no trigger', () => {
    expect(writerInputFromSynthesis(input(3, null)).supportingCandidateId).toBeNull()
  })

  /**
   * THE CASE A `!==` COMPARISON GETS WRONG. Two candidates that each matched nothing have not
   * matched each other. null === null is true, so a naive equality check would pass this pair
   * through as though they shared a trigger, which is the exact opposite of the rule.
   */
  it('DROPS when NEITHER matched a trigger, because that is not agreement', () => {
    expect(writerInputFromSynthesis(input(null, null)).supportingCandidateId).toBeNull()
  })

  /**
   * Rows written before 2026-09-23 have the key ABSENT rather than null. undefined must behave
   * exactly as null does, or a pre-2026-09-23 pair would pass on `undefined === undefined`.
   */
  it('DROPS when the key is absent on both, not merely null', () => {
    expect(writerInputFromSynthesis(input(undefined, undefined)).supportingCandidateId).toBeNull()
  })

  it('DROPS when the supporting candidate is not in the list at all', () => {
    const i = input(3, 3)
    i.candidates = [i.candidates[0]]
    expect(writerInputFromSynthesis(i).supportingCandidateId).toBeNull()
  })

  it('CONTROL: nothing else in the mapping is disturbed', () => {
    const out = writerInputFromSynthesis(input(3, 5))
    expect(out.selectedCandidateId).toBe('main')
    expect(out.relevanceReason).toBe('invented')
    expect(out.candidates).toHaveLength(2)
  })

  it('CONTROL: no supporting id at all stays null and throws nothing', () => {
    const out = writerInputFromSynthesis({
      candidates: [candidate('main', 3)],
      selected_candidate_id: 'main',
      relevance_reason: 'invented',
    })
    expect(out.supportingCandidateId).toBeNull()
  })
})
