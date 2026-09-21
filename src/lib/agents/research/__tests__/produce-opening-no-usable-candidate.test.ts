// WHEN SYNTHESIS FINDS NO USABLE CANDIDATE, THE WRITER DOES NOT RUN. Added 2026-09-11.
//
// Both directions, because a gate that stops everything passes the "stops" half of a test
// and is an outage. Each stopped case has a matching written case one field away from it.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// vi.hoisted, because vi.mock is hoisted above every top-level const, and a factory that
// closes over one fails to load the file at all. The first version did exactly that, and the
// suite reported 0 failures because this file reported 0 tests.
const { writeAndJudgeOpening } = vi.hoisted(() => ({ writeAndJudgeOpening: vi.fn() }))
vi.mock('../write-opening', () => ({ writeAndJudgeOpening }))
vi.mock('@/lib/composition/compose-sequence', () => ({
  getVariantEmail1Frame: () => ({ p3: 'The offer line.', cta: 'Is that useful?', authoredOpening: 'The approved opening.' }),
  composeEmail1WithOpening: vi.fn(),
}))

import { produceOpening, NO_USABLE_CANDIDATE_REASON } from '../produce-opening'
import { hasUsableCandidate } from '../synthesize'
import { EMPTY_FOLLOWUP } from '../followup-frame'
import type { ObservationCandidate, ProspectContext } from '../types'

type Scores = ObservationCandidate['scores']
const ALL: Scores = { specific: true, verifiable: true, inferential: true, relevant: true, useful: true, non_judgemental: true }

function candidate(over: Partial<Scores> = {}, extra: Partial<ObservationCandidate> = {}): ObservationCandidate {
  const scores = { ...ALL, ...over }
  const score_total = Object.values(scores).filter(Boolean).length
  return {
    id: 'c1', observation: 'You added a second press in March.', source: 'website', provenance: 'example.com',
    date: null, is_composite: false, scores, passes_all: score_total === 6, score_total,
    model_readable_claim: true, opposite_reading: 'It may replace an old press.', inference_direction: 'compatible_with_both',
    readability: { hard_fail: false, penalty: 0, max_sentence_words: 7, hedges: [], nominalisation_density: 0, nominalisation_over_threshold: false, reasons: [] },
    demoted: false, rejection_reason: null, ...extra,
  }
}

const ctx: ProspectContext = {
  id: 'p1', organisation_id: 'org1', segment_id: null, first_name: 'Sam', last_name: null,
  company_name: 'Example Co', country: null, role: null, job_title: 'Founder', email: null,
  linkedin_url: null, website_url: null, company: null,
}

const WRITTEN = { written_won: true, judge_reasoning: 'written', usage: { calls: 3 } }

function run(candidates: ObservationCandidate[], selectedCandidateId: string | null = null) {
  return produceOpening({
    apiKey: 'k', clientName: 'Client', ctx, candidates, selectedCandidateId, relevanceReason: 'R',
    messagingContent: {} as never, variantId: 'A',
  })
}

beforeEach(() => {
  writeAndJudgeOpening.mockReset()
  writeAndJudgeOpening.mockResolvedValue(WRITTEN)
})

describe('the writer is stopped when synthesis finds no usable candidate', () => {
  it('stops when no candidate is relevant, and returns the not-written result', async () => {
    const out = await run([candidate({ relevant: false }), candidate({ relevant: false }, { id: 'c2' })])
    expect(writeAndJudgeOpening).not.toHaveBeenCalled()
    expect(out.written_won).toBe(false)
    expect(out.opening).toBeNull()
    expect(out.judge_reasoning).toBe(NO_USABLE_CANDIDATE_REASON)
    expect(out.usage.calls).toBe(0)
    // THE CODE THE OPERATOR'S LIST READS. Stored in trigger_data.judge on the prospect.
    expect(out.not_written_reason).toBe('no_usable_candidate')
  })

  it('stops when the only relevant candidate is not verifiable, which is not enough to use', async () => {
    await run([candidate({ verifiable: false, useful: false })])
    expect(writeAndJudgeOpening).not.toHaveBeenCalled()
  })

  it('stops when there are no candidates at all', async () => {
    await run([])
    expect(writeAndJudgeOpening).not.toHaveBeenCalled()
  })
})

describe('the writer still runs whenever synthesis would use a candidate', () => {
  it('runs for a six-out-of-six candidate', async () => {
    const out = await run([candidate()])
    expect(writeAndJudgeOpening).toHaveBeenCalledTimes(1)
    // NOT `toBe`. produceOpening no longer passes the writer's object through by
    // reference: since the follow-up call was added it returns a NEW object carrying the
    // writer's result plus the two follow-up outcomes. The writer's own fields must still
    // arrive untouched, which is what this asserts, and identity was never the contract
    // that mattered.
    expect(out).toMatchObject(WRITTEN)
    // A written opening, won or lost, never carries the not-written code.
    expect((out as { not_written_reason?: string }).not_written_reason).toBeUndefined()

    // AND THE COHERENCE RULE ON THIS PATH, which the old identity assertion could not
    // reach. `run` does not pass writeFollowupEmails, which is the production state: both
    // production callers omit it. So no follow-up call is made and both outcomes are
    // empty, even though Email 1 won.
    expect(out.email2).toEqual(EMPTY_FOLLOWUP)
    expect(out.email3).toEqual(EMPTY_FOLLOWUP)
    expect(out.followup_usage).toBeNull()
  })

  it('runs for a candidate that passes only SPECIFIC + VERIFIABLE + RELEVANT', async () => {
    await run([candidate({ inferential: false, useful: false })])
    expect(writeAndJudgeOpening).toHaveBeenCalledTimes(1)
  })

  it('runs for a six-out-of-six candidate a gate demoted, because it still falls through to the lower tier', async () => {
    await run([candidate({}, { demoted: true, readability: { ...candidate().readability, hard_fail: true } })])
    expect(writeAndJudgeOpening).toHaveBeenCalledTimes(1)
  })

  it('runs when the selection is null, which is still a real case, if a usable candidate is there', async () => {
    // THE TRAP THIS AVOIDS. Keyed on the selection, this check would stop every prospect
    // whose row carries no selection. That was EVERY reuse run until 2026-09-14, when the
    // reuse path began carrying the selection its source row recorded. It is now only a row
    // predating the column, or one whose run reached no selection, so the trap is narrower
    // and the guard still matters: the two questions are independent and must stay so.
    await run([candidate()], null)
    expect(writeAndJudgeOpening).toHaveBeenCalledTimes(1)
  })

  it('runs when the selection is present, which a reuse run now carries', async () => {
    await run([candidate()], 'c1')
    expect(writeAndJudgeOpening).toHaveBeenCalledTimes(1)
  })
})

describe('hasUsableCandidate is the selection rule, both ways', () => {
  it('does not throw on a stored candidate from before readability was recorded, and judges it by its scores', () => {
    // THREE SUCH ROWS were in the 30-day reuse window on 2026-09-11, all from 2026-08-18. None
    // was the row a reuse run would pick, but this check now runs on stored candidates on every
    // writer path, so an old shape must not be able to crash a research run.
    const legacy = { ...candidate(), readability: undefined, inference_direction: undefined } as unknown as ObservationCandidate
    expect(() => hasUsableCandidate([legacy])).not.toThrow()
    expect(hasUsableCandidate([legacy])).toBe(true)
    const legacyIrrelevant = { ...candidate({ relevant: false }), readability: undefined, inference_direction: undefined } as unknown as ObservationCandidate
    expect(hasUsableCandidate([legacyIrrelevant])).toBe(false)
  })

  it('is true for a usable candidate and false for a list with none', () => {
    expect(hasUsableCandidate([candidate()])).toBe(true)
    expect(hasUsableCandidate([candidate({ relevant: false })])).toBe(false)
  })
})
