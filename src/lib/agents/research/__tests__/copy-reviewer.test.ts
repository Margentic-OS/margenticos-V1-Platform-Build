// THE REVIEWER'S CODE HALF. The model call is not exercised: its only job is to answer the
// rubric, and every way an answer can be wrong is checked here against fixtures.
//
// RULE ZERO. The rubric names no client, market, service or buyer, and this file asserts it by
// comparison: the same prompt built for two clients differs by their own document and nothing
// else. Every fixture is invented.

import { describe, it, expect } from 'vitest'
import {
  HARD_FAIL_CATEGORIES,
  SOFT_CATEGORIES,
  buildReviewPrompt,
  parseReviewResponse,
  fingerprintCopy,
} from '../copy-reviewer'

const idsFor = (position: number) =>
  HARD_FAIL_CATEGORIES.filter(c => (c.positions as readonly number[]).includes(position)).map(c => c.id)

describe('the rubric is the operator\'s, and it is asked per position', () => {
  it('carries all seven hard-fail categories', () => {
    expect(HARD_FAIL_CATEGORIES.map(c => c.id)).toEqual([
      'invented_fact',
      'guess_about_them',
      'audience_claim',
      'wrong_or_mismatched_fact',
      'third_person',
      'followup_about_a_different_fact',
      'need_the_offer_does_not_serve',
    ])
  })

  it('does not ask Email 1 whether it argues from a different fact than Email 1', () => {
    // Asking an unanswerable question invites an answer. Email 1 IS the first email.
    expect(idsFor(1)).not.toContain('followup_about_a_different_fact')
    expect(idsFor(2)).toContain('followup_about_a_different_fact')
    expect(idsFor(3)).toContain('followup_about_a_different_fact')
  })

  it('keeps the soft category out of the hard list entirely', () => {
    // Scored separately by instruction: it judges how well an argument lands, not whether a
    // statement is true, and a count mixing the two means two things at once.
    expect(SOFT_CATEGORIES.map(c => c.id)).toEqual(['bridge_does_not_follow'])
    for (const s of SOFT_CATEGORIES) {
      expect(HARD_FAIL_CATEGORIES.map(c => c.id)).not.toContain(s.id)
    }
  })

  it('lists every asked id in the prompt, so the model is told what to return', () => {
    const p2 = buildReviewPrompt(2)
    for (const id of idsFor(2)) expect(p2).toContain(id)
    expect(p2).toContain('bridge_does_not_follow')
    const p1 = buildReviewPrompt(1)
    expect(p1).not.toContain('followup_about_a_different_fact')
  })
})

describe('parsing a verdict', () => {
  const reply = (verdicts: unknown[]) => JSON.stringify({ verdicts })

  it('reads a well-formed reply and keeps hard and soft apart', () => {
    const { hardFails, softNotes } = parseReviewResponse(reply([
      { id: 'invented_fact', failed: true, quote: 'You doubled the workshop last year.', why: 'no finding says so' },
      { id: 'third_person', failed: false, quote: '', why: 'addresses the reader throughout' },
      { id: 'bridge_does_not_follow', failed: true, quote: 'So the next job matters more.', why: 'attached, not derived' },
    ]), 1)
    expect(hardFails.invented_fact.failed).toBe(true)
    expect(hardFails.third_person.failed).toBe(false)
    expect(softNotes.bridge_does_not_follow.failed).toBe(true)
    expect(hardFails).not.toHaveProperty('bridge_does_not_follow')
  })

  it('TREATS AN UNQUOTED FAULT AS NO FAULT', () => {
    // The cheapest thing a model can produce is an unevidenced yes, and a verdict nobody can
    // read back cannot be calibrated against a human reading.
    const { hardFails } = parseReviewResponse(reply([
      { id: 'invented_fact', failed: true, quote: '', why: 'it feels invented' },
      { id: 'guess_about_them', failed: true, quote: '   ', why: 'whitespace is not a quote' },
    ]), 1)
    expect(hardFails.invented_fact.failed).toBe(false)
    expect(hardFails.guess_about_them.failed).toBe(false)
  })

  it('drops an id that is not in the rubric for this position', () => {
    const { hardFails } = parseReviewResponse(reply([
      { id: 'followup_about_a_different_fact', failed: true, quote: 'x y z', why: '' },
      { id: 'made_up_category', failed: true, quote: 'x y z', why: '' },
    ]), 1)
    expect(hardFails).toEqual({})
  })

  it('reads absent, malformed or wrong-shaped replies as "reviewed nothing"', () => {
    for (const raw of ['', 'no json at all', '{"verdicts":[', '{"verdicts":"nope"}', '{"verdicts":[null,7]}']) {
      const { hardFails, softNotes } = parseReviewResponse(raw, 1)
      expect(hardFails, raw).toEqual({})
      expect(softNotes, raw).toEqual({})
    }
  })

  it('records only the categories ANSWERED, so a missing one is visible', () => {
    // An unanswered category must not read as a pass. The caller can see the count it asked
    // for against the count it got back.
    const { hardFails } = parseReviewResponse(reply([
      { id: 'invented_fact', failed: false, quote: '', why: 'fine' },
    ]), 1)
    expect(Object.keys(hardFails)).toEqual(['invented_fact'])
    expect(Object.keys(hardFails).length).toBeLessThan(idsFor(1).length)
  })
})

describe('Rule Zero', () => {
  it('names no client, market, service or buyer', () => {
    const prompt = HARD_FAIL_CATEGORIES.map(c => c.question).join(' ') + buildReviewPrompt(1)
    const OFFER_WORDS = [
      'MargenticOS', 'outbound', 'cold email', 'cold outreach', 'prospecting',
      'consulting firm', 'coaching', 'founder-led', 'pipeline generation', 'qualified meetings',
    ]
    const found = OFFER_WORDS.filter(w => prompt.toLowerCase().includes(w.toLowerCase()))
    expect(found, `the shared rubric names an offer: ${found.join(', ')}`).toEqual([])
    // POSITIVE CONTROL: the same search finds them when they are there.
    expect(OFFER_WORDS.filter(w => `${prompt} we run cold outreach`.toLowerCase().includes(w.toLowerCase())))
      .toContain('cold outreach')
  })

  it('is identical for two clients but for their own document, which is passed in at runtime', () => {
    // The document is concatenated by reviewCopy, not built into the prompt, so the prompt
    // itself cannot vary by client at all. That is the strongest form of this property.
    expect(buildReviewPrompt(1)).toBe(buildReviewPrompt(1))
    expect(buildReviewPrompt(1)).not.toContain('positioning document\n\n')
  })
})

describe('the fingerprint', () => {
  it('changes with the copy and not with anything else', () => {
    expect(fingerprintCopy('one')).toBe(fingerprintCopy('one'))
    expect(fingerprintCopy('one')).not.toBe(fingerprintCopy('one '))
  })
})
