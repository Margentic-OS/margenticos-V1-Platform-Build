// A FACT WITH AN APPROVED REASON IS CHOSEN OVER ONE WITHOUT, WHEN THERE IS ONE (ADR-065).
//
// A personalised opening argues from the client's approved reason for the trigger the
// chosen fact matched, and a fact that matched none is not written at all. The model picks
// among eligible facts with no instruction to prefer a matched one, so it could name an
// unmatched fact while a matched, eligible one sat beside it, and the prospect then got no
// personalised opening although research had found a fact the client says matters.
//
// Through synthesis, as the model's raw text in and a SynthesisOutput out: the same path
// production takes. Fixtures are invented and industry-neutral.

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { parseSynthesisResponse, hasUsableCandidate } from '../synthesize'
import { resolveApprovedReason } from '../approved-reason'
import type { ProspectContext } from '../types'

const prospect = {
  id: 'p1', organisation_id: 'o1', segment_id: null, first_name: 'Sam', last_name: 'Reed',
  company_name: 'Northbank', country: null,
} as unknown as ProspectContext

const signal = { has_dateable_signal: true, signal_observation: null }

const TRIGGERS = [
  { trigger: 'A second machine is installed.', reason: 'A second machine points to growth, and growth needs more orders.' },
  { trigger: 'A new site is opened.', reason: 'A new site means the firm is reaching a new area.' },
  { trigger: 'An award is won.', reason: '' },
]

function candidate(over: Record<string, unknown>) {
  return {
    observation: 'You installed a second machine in March.',
    provenance: 'https://example.com/post',
    source: 'linkedin',
    scores: { specific: true, verifiable: true, inferential: true, relevant: true, useful: true, non_judgemental: true, readable: true },
    opposite_reading: 'It may replace an old machine.',
    inference_direction: 'compatible_with_both',
    ...over,
  }
}

const daysAgo = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10)

function run(candidates: unknown[], selected: string | null, triggers = TRIGGERS) {
  const raw = JSON.stringify({
    icp_fit: 'strong', qualification_status: 'qualified', confidence: 'high',
    relevance_reason: 'They sell to the same buyer.', candidates, selected_candidate_id: selected,
  })
  return parseSynthesisResponse(raw, prospect, 'ICP summary', signal, null, 'material', triggers)
}

describe('the choice is made among facts that carry an approved reason, when any does', () => {
  const unmatched = candidate({ id: 'c-post', matched_trigger: null, date: daysAgo(3), observation: 'You wrote about night shifts last week.' })
  const matched = candidate({ id: 'c-machine', matched_trigger: 1, date: daysAgo(120) })

  it('PLANTED: the model names an unmatched fact while a matched one is eligible: the matched one is chosen, and the pick is recorded as set aside', () => {
    const out = run([unmatched, matched], 'c-post')
    expect(out.selected_candidate_id).toBe('c-machine')
    expect(out.selection_basis?.set_aside_model_pick).toBe('c-post')
    // And that choice resolves to an approved reason, which is what the rule was for.
    expect(resolveApprovedReason(out.candidates, out.selected_candidate_id, TRIGGERS)).toMatchObject({ state: 'approved', triggerIndex: 1 })
  })

  it('the model\'s pick stands when it IS a fact with an approved reason', () => {
    const second = candidate({ id: 'c-site', matched_trigger: 2, date: daysAgo(200), observation: 'You opened a site in the north.' })
    const out = run([matched, second], 'c-site')
    expect(out.selected_candidate_id).toBe('c-site')
    expect(out.selection_basis?.set_aside_model_pick ?? null).toBeNull()
  })

  it('PLANTED: a trigger with NO reason written does not count as having one', () => {
    // The award trigger carries no reason, so a fact matching it is no better than unmatched.
    const award = candidate({ id: 'c-award', matched_trigger: 3, date: daysAgo(2), observation: 'You won the regional award.' })
    const out = run([award, matched], 'c-award')
    expect(out.selected_candidate_id).toBe('c-machine')
    expect(out.selection_basis?.set_aside_model_pick).toBe('c-award')
  })

  it('nothing changes when NO eligible fact has an approved reason (the control)', () => {
    const other = candidate({ id: 'c-other', matched_trigger: null, date: daysAgo(40), observation: 'You spoke at the trade fair.' })
    const out = run([unmatched, other], 'c-other')
    expect(out.selected_candidate_id).toBe('c-other')
    expect(out.selection_basis?.set_aside_model_pick ?? null).toBeNull()
  })

  it('nothing changes for a client with no trigger list (the control)', () => {
    const out = run([unmatched, matched], 'c-post', [])
    expect(out.selected_candidate_id).toBe('c-post')
  })

  it('whether there is a usable fact at all does not depend on triggers', () => {
    expect(hasUsableCandidate(run([unmatched], null).candidates)).toBe(true)
  })
})

describe('the trigger\'s wording travels with its position', () => {
  const matched = candidate({ id: 'c-machine', matched_trigger: 1, date: daysAgo(10) })

  it('PLANTED: synthesis attaches the wording of the matched trigger, from the list it was given', () => {
    const out = run([matched], 'c-machine')
    expect(out.candidates[0].matched_trigger_text).toBe('A second machine is installed.')
  })

  it('a position the list does not have gets no wording', () => {
    const out = run([candidate({ id: 'c', matched_trigger: 9, date: daysAgo(10) })], 'c')
    expect(out.candidates[0].matched_trigger_text ?? null).toBeNull()
  })

  const stored = [{ id: 'c-machine', matched_trigger: 1, matched_trigger_text: 'A second machine is installed.' }]

  it('the same list resolves to that trigger\'s reason as it reads TODAY', () => {
    const reworded = [{ trigger: 'A second machine is installed.', reason: 'A second machine means the firm is set on growing.' }, TRIGGERS[1]]
    expect(resolveApprovedReason(stored, 'c-machine', reworded)).toMatchObject({ state: 'approved', reason: 'A second machine means the firm is set on growing.' })
  })

  it('PLANTED: a REORDERED list is followed to where the trigger now sits, not read at the old position', () => {
    const reordered = [TRIGGERS[1], TRIGGERS[0], TRIGGERS[2]]
    expect(resolveApprovedReason(stored, 'c-machine', reordered)).toMatchObject({
      state: 'approved', triggerIndex: 2, reason: 'A second machine points to growth, and growth needs more orders.',
    })
  })

  it('PLANTED: a trigger that was removed or rewritten no longer matches, whatever sits at its old position', () => {
    const replaced = [{ trigger: 'A founder appears on a podcast.', reason: 'The firm looks ready for more clients.' }, TRIGGERS[1]]
    expect(resolveApprovedReason(stored, 'c-machine', replaced)).toEqual({ state: 'no_trigger_matched' })
  })

  it('a candidate stored before the wording was recorded is resolved by position alone', () => {
    expect(resolveApprovedReason([{ id: 'c', matched_trigger: 2 }], 'c', TRIGGERS)).toMatchObject({ state: 'approved', triggerIndex: 2 })
    expect(resolveApprovedReason([{ id: 'c', matched_trigger: 9 }], 'c', TRIGGERS)).toEqual({ state: 'no_trigger_matched' })
  })
})
