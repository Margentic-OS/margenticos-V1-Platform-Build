// LABELS THAT SAY WHAT THE CODE ACTUALLY DOES.
//
// Two defects of the same family, both found on 2026-09-24 and both fixed here:
//
//   1. Comments in checkOpeningGates called BLOCKING gates report-only. A comment that
//      says a gate cannot reject is read by whoever is deciding where a rejection came
//      from, and it sends them to look somewhere else.
//
//   2. parseCandidate threw the MODEL's own rejection reason away whenever our gates had a
//      demotion note of their own, so a demoted candidate looked like a formatting casualty
//      even when the model had rejected the material outright.
//
// THE COMMENT HALF IS MADE EXECUTABLE HERE, which is the only way it stays true. Asserting
// the prose would break on a rewording; asserting the BEHAVIOUR breaks when a mode flips,
// which is exactly when the comment needs editing.

import { describe, it, expect } from 'vitest'
import { checkOpeningGates, WRITER_MAX_SENTENCE_WORDS } from '../write-opening'
import { ACTIVITY_VERDICT_MODE } from '@/lib/style/activity-verdict'
import { OPENING_REFERENCE_MODE } from '@/lib/style/opening-reference'
import { FINITE_VERB_GATE_MODE } from '@/lib/style/finite-verb'
import { parseSynthesisResponse } from '../synthesize'
import type { ProspectContext } from '../types'

describe('which per-part checks block, asserted rather than described', () => {
  const question = 'Is that something you are working on?'
  const gatesFor = (observation: string, bridge: string) => checkOpeningGates(
    `${observation}\n\n${bridge} ${question}`, null, `${observation} ${bridge}`, undefined,
    { observation, bridge, question }, { prospectId: 'honest-labels' },
  )

  it('the activity verdict BLOCKS, and the constant says so', () => {
    // The comment said 'report' for eight days after this was flipped to 'block'.
    expect(ACTIVITY_VERDICT_MODE).toBe('block')
    // The same banned shape activity-verdict.test.ts pins, reached through the WRITER'S
    // gate rather than the detector directly, which is the hop the stale comment was about.
    const failures = gatesFor(
      'You opened a second site in March.',
      "The leaders who heard you speak don't yet know you take new clients.",
    )
    expect(failures.length).toBeGreaterThan(0)
  })

  it('sentence length BLOCKS, which the comment said was logged and never read', () => {
    const long = Array.from({ length: WRITER_MAX_SENTENCE_WORDS + 1 }, (_, i) => (i === 0 ? 'Word' : 'word')).join(' ') + '.'
    const failures = gatesFor('You opened a second site in March.', long)
    expect(failures.some(f => f.includes('has a sentence of'))).toBe(true)
  })

  it('the opening-reference check REPORTS, and its constant still says report', () => {
    // The one label of the three that was accurate. Pinned so that flipping the constant
    // fails here and whoever flips it has to correct the comment in the same commit.
    expect(OPENING_REFERENCE_MODE).toBe('report')
  })

  it('the finite-verb check REPORTS, and its constant still says report', () => {
    expect(FINITE_VERB_GATE_MODE).toBe('report')
  })
})

describe('a demoted candidate keeps the model’s own rejection reason', () => {
  const PROSPECT = {
    id: 'p1', organisation_id: 'o1', first_name: 'Test', last_name: 'Person',
    company_name: 'Example Co', job_title: 'Operator', country: 'GB',
  } as unknown as ProspectContext

  // A candidate the MODEL rejected in its own words, which our readability gate ALSO hard
  // fails. Before this change the model's sentence was discarded outright.
  const response = (rejection: string) => JSON.stringify({
    icp_fit: 'moderate',
    has_dateable_signal: true,
    qualification_status: 'qualified',
    candidates: [{
      id: 'c1',
      // Long, clause-heavy and abstract, which is what the readability hard fail is for.
      observation: 'The organisation has been undergoing a period of operational transformation which, in conjunction with prevailing market headwinds, has necessitated a reconsideration of its commercial posture across multiple territories.',
      source: 'website',
      provenance: 'the company website',
      date: '2026-03-01',
      rejection_reason: rejection,
      scores: { specific: true, verifiable: true, recent: true, readable: false, relevant: true, actionable: true },
    }],
  })

  // Minimal but real: parseSynthesisResponse reads has_dateable_signal off it.
  const DETECTED_SIGNAL = { has_dateable_signal: true, signal: null } as never

  const parse = (rejection: string) =>
    parseSynthesisResponse(response(rejection), PROSPECT, 'an ICP summary', DETECTED_SIGNAL, null, 'material')

  it('keeps BOTH the model’s reason and the demotion note', () => {
    const MODEL_REASON = 'The claim is about the market rather than about this company.'
    const out = parse(MODEL_REASON)
    const candidate = out.candidates.find(c => c.id === 'c1')
    expect(candidate, 'the fixture candidate did not parse').toBeTruthy()

    // THE CONTROL ON THE PREMISE: there must BE a demotion note, or this test would pass
    // on the old code too, which kept the model's reason whenever there was none.
    expect(candidate!.rejection_reason).toContain('Readability:')
    // THE CLAIM.
    expect(candidate!.rejection_reason).toContain(MODEL_REASON)
    // Labelled, so a reader can tell which author said which.
    expect(candidate!.rejection_reason).toContain(`Model: ${MODEL_REASON}`)
  })

  it('reads as the demotion note alone when the model gave no reason', () => {
    const out = parse('')
    const candidate = out.candidates.find(c => c.id === 'c1')
    expect(candidate!.rejection_reason).toContain('Readability:')
    expect(candidate!.rejection_reason).not.toContain('Model:')
  })
})
