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

  // INVERTED 2026-09-24. This used to assert that the model could NOT overturn the ordering,
  // which was the arrangement at the time: the arithmetic decided and the model's pick only
  // broke ties. Code now decides only what is OUT, and among what is left the model chooses,
  // because which candidate makes the strongest case for THIS prospect is a judgement and
  // recency-then-specificity was arithmetic standing in for one.
  it('THE MODEL CHOOSES among eligible candidates, even against the ordering', () => {
    const out = run(respond([
      candidate({ id: 'c1', matched_trigger: 1, date: daysAgo(270) }),
      candidate({ id: 'c2', matched_trigger: 6, date: daysAgo(9) }),
    ], { selected_candidate_id: 'c1' }))
    expect(out.selected_candidate_id).toBe('c1')
    // AND THE OVERRIDE IS ON THE RECORD. A model choice nobody can compare against anything
    // is a choice nobody can review.
    expect(out.selection_basis?.arithmetic_chosen_id).toBe('c2')
    expect(out.selection_basis?.model_chosen_id).toBe('c1')
    expect(out.selection_basis?.model_differs_from_arithmetic).toBe(true)
  })

  it('falls back to the ordering when the model names nothing', () => {
    const out = run(respond([
      candidate({ id: 'c1', matched_trigger: 1, date: daysAgo(270) }),
      candidate({ id: 'c2', matched_trigger: 6, date: daysAgo(9) }),
    ]))
    expect(out.selected_candidate_id).toBe('c2')
    expect(out.selection_basis?.model_differs_from_arithmetic).toBe(false)
  })

  it('falls back to the ordering when the model names an INELIGIBLE candidate', () => {
    // c3 fails the six tests, so it is out however firmly the model asks for it. The
    // eligible set is never empty on this path, so there is always a defensible answer.
    const out = run(respond([
      candidate({ id: 'c1', matched_trigger: 6, date: daysAgo(9) }),
      candidate({ id: 'c3', matched_trigger: 1, date: daysAgo(2), scores: { specific: false } }),
    ], { selected_candidate_id: 'c3' }))
    expect(out.selected_candidate_id).toBe('c1')
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

  // EVERY SHAPE, because the first version of this test used only 'first', and a mutation
  // replacing the parse with Number(v) || null passed it: Number('first') is NaN and NaN ||
  // null is null, so the mutation and the guard agreed on the one input being tested. A
  // fraction and a zero are what actually separate them.
  it.each([
    ['a word',          'first', null],
    ['a fraction',      2.5,     null],
    ['zero',            0,       null],
    ['a negative',      -1,      null],
    ['null',            null,    null],
    ['a whole number',  3,       3],
    ['a string of digits', '3',  3],
  ])('matched_trigger from %s reads as %s', (_label, given, expected) => {
    const out = run(respond([candidate({ id: 'c1', matched_trigger: given, date: daysAgo(9) })]))
    expect(out.candidates.find(c => c.id === 'c1')?.matched_trigger).toBe(expected)
  })

  it('a candidate whose position could not be read ranks below one whose could', () => {
    const out = run(respond([
      candidate({ id: 'c1', matched_trigger: 2.5, date: daysAgo(9) }),
      candidate({ id: 'c2', matched_trigger: 2,   date: daysAgo(200) }),
    ]))
    expect(out.selected_candidate_id).toBe('c2')
  })
})
