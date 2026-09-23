// THE ORDERING, THROUGH SYNTHESIS, NOT THROUGH THE COMPARATOR ALONE.
//
// rank-candidates.test.ts proves the comparator. This proves SYNTHESIS CALLS IT, and that
// what it records about the choice matches what the arithmetic did. That seam is the one
// that has broken before: on 2026-09-11 the selection was computed correctly and never
// reached the writer, and every test on each end was green throughout.
//
// Every case here goes in as the model's raw response text and comes out as a SynthesisOutput,
// which is the same path production takes.

import { describe, it, expect } from 'vitest'
import { parseSynthesisResponse } from '../synthesize'
import type { ProspectContext } from '../types'

const prospect: ProspectContext = {
  id: 'p1',
  organisation_id: 'o1',
  segment_id: null,
  first_name: 'Sam',
  last_name: 'Reed',
  company_name: 'Northbank',
  country: null,
} as unknown as ProspectContext

const signal = { has_dateable_signal: true, signal_observation: null }

/** A candidate that passes all six tests and both gates, so it reaches the hook tier. */
function candidate(over: Record<string, unknown>) {
  return {
    observation: 'You published a piece on procurement in March.',
    provenance: 'https://example.com/post',
    source: 'linkedin',
    scores: {
      specific: true, verifiable: true, inferential: true,
      relevant: true, useful: true, non_judgemental: true, readable: true,
    },
    opposite_reading: 'They could have published it for recruiting reasons instead.',
    inference_direction: 'compatible_with_both',
    ...over,
  }
}

function respond(candidates: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    icp_fit: 'strong',
    qualification_status: 'qualified',
    confidence: 'high',
    relevance_reason: 'They sell to the same buyer.',
    candidates,
    selected_candidate_id: null,
    ...extra,
  })
}

function run(raw: string) {
  return parseSynthesisResponse(raw, prospect, 'ICP summary', signal, null, 'material')
}

// Dates relative to now, so these do not rot into "everything is ancient" in six months.
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 864e5).toISOString().slice(0, 10)
}

describe('selection ordering, through synthesis', () => {
  it('RECENCY BEATS TRIGGER POSITION. The whole point of the change.', () => {
    const out = run(respond([
      candidate({ id: 'c1', matched_trigger: 1, date: daysAgo(270), observation: 'The old one.' }),
      candidate({ id: 'c2', matched_trigger: 6, date: daysAgo(9),   observation: 'The recent one.' }),
    ]))
    expect(out.selected_candidate_id).toBe('c2')
    expect(out.selection_basis?.position_only_id).toBe('c1')
    expect(out.selection_basis?.differs_from_position_only).toBe(true)
  })

  it('matching a trigger beats not matching one, whatever the dates say', () => {
    const out = run(respond([
      candidate({ id: 'c1', matched_trigger: null, date: daysAgo(2) }),
      candidate({ id: 'c2', matched_trigger: 4,    date: daysAgo(150) }),
    ]))
    expect(out.selected_candidate_id).toBe('c2')
  })

  it('their own post beats a reshare even when the reshare is newer', () => {
    const out = run(respond([
      candidate({ id: 'c1', matched_trigger: 2, date: daysAgo(40), is_reshare: false }),
      candidate({ id: 'c2', matched_trigger: 2, date: daysAgo(3),  is_reshare: true }),
    ]))
    expect(out.selected_candidate_id).toBe('c1')
  })

  it('a reshare still wins when nothing of their own qualifies, and stays marked', () => {
    const out = run(respond([
      candidate({ id: 'c1', matched_trigger: 2, date: daysAgo(3), is_reshare: true }),
    ]))
    expect(out.selected_candidate_id).toBe('c1')
    expect(out.candidates.find(c => c.id === 'c1')?.is_reshare).toBe(true)
  })

  it('an undated candidate ranks below every dated one, however old the dated one is', () => {
    const out = run(respond([
      candidate({ id: 'c1', matched_trigger: 1, date: null }),
      candidate({ id: 'c2', matched_trigger: 9, date: daysAgo(300) }),
    ]))
    expect(out.selected_candidate_id).toBe('c2')
  })

  it('trigger position breaks a tie the criteria above could not', () => {
    const d = daysAgo(20)
    const out = run(respond([
      candidate({ id: 'c1', matched_trigger: 7, date: d }),
      candidate({ id: 'c2', matched_trigger: 3, date: d }),
    ]))
    expect(out.selected_candidate_id).toBe('c2')
    // And list position agreed here, which is the control for the test above it: the
    // comparison only means something if it can come back false.
    expect(out.selection_basis?.differs_from_position_only).toBe(false)
  })

  it('the model cannot overturn the ordering with selected_candidate_id', () => {
    const out = run(respond([
      candidate({ id: 'c1', matched_trigger: 1, date: daysAgo(270) }),
      candidate({ id: 'c2', matched_trigger: 6, date: daysAgo(9) }),
    ], { selected_candidate_id: 'c1' }))
    expect(out.selected_candidate_id).toBe('c2')
  })

  it('the model CAN break a tie the arithmetic left, which is the control for the line above', () => {
    const d = daysAgo(20)
    const out = run(respond([
      candidate({ id: 'c1', matched_trigger: 3, date: d }),
      candidate({ id: 'c2', matched_trigger: 3, date: d }),
    ], { selected_candidate_id: 'c2' }))
    expect(out.selected_candidate_id).toBe('c2')
  })
})

describe('the sentence about the choice', () => {
  it('is kept when there was a choice to make', () => {
    const out = run(respond([
      candidate({ id: 'c1', matched_trigger: 1, date: daysAgo(270) }),
      candidate({ id: 'c2', matched_trigger: 6, date: daysAgo(9) }),
    ], { selection_reason: 'Chose c2, nine days old, over c1 from nine months ago.' }))
    expect(out.selection_reason).toBe('Chose c2, nine days old, over c1 from nine months ago.')
    expect(out.selection_basis?.chosen_id).toBe('c2')
    expect(out.selection_basis?.runner_up_id).toBe('c1')
  })

  it('is DROPPED when there was only one candidate, so it cannot describe a choice nobody made', () => {
    const out = run(respond([
      candidate({ id: 'c1', matched_trigger: 1, date: daysAgo(9) }),
    ], { selection_reason: 'Chose c1 over c2 because it is more recent.' }))
    expect(out.selection_reason).toBe('')
    expect(out.selection_basis?.runner_up_id).toBeNull()
  })

  it('records the basis of both, so a sentence that contradicts the arithmetic is visible', () => {
    const out = run(respond([
      candidate({ id: 'c1', matched_trigger: 1, date: daysAgo(270) }),
      candidate({ id: 'c2', matched_trigger: 6, date: daysAgo(9) }),
    ], { selection_reason: 'x' }))
    expect(out.selection_basis?.chosen_basis.days_old).toBe(9)
    expect(out.selection_basis?.runner_up_basis?.days_old).toBe(270)
    expect(out.selection_basis?.chosen_basis.trigger_position).toBe(6)
  })

  it('a garbage matched_trigger reads as matching nothing, never as position 0 or NaN', () => {
    const out = run(respond([
      candidate({ id: 'c1', matched_trigger: 'first', date: daysAgo(9) }),
      candidate({ id: 'c2', matched_trigger: 2,       date: daysAgo(200) }),
    ]))
    expect(out.candidates.find(c => c.id === 'c1')?.matched_trigger).toBeNull()
    expect(out.selected_candidate_id).toBe('c2')
  })
})
