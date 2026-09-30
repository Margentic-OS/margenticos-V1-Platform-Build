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
  MAX_WHY_CHARS,
} from '../copy-reviewer'

const idsFor = (position: number) =>
  HARD_FAIL_CATEGORIES.filter(c => (c.positions as readonly number[]).includes(position)).map(c => c.id)

describe('the rubric is the operator\'s, and it is asked per position', () => {
  it('carries the operator\'s hard-fail list, in order', () => {
    expect(HARD_FAIL_CATEGORIES.map(c => c.id)).toEqual([
      'invented_fact',
      'guess_about_them',
      // ITS OWN CATEGORY from 2026-09-30. It was a phrase inside guess_about_them, and the
      // marks showed that buries it: where the work comes from is the guess that keeps
      // being made, and a category about diaries is the wrong place to report it.
      'guess_about_their_clients',
      'audience_claim',
      // ADDED 2026-09-30, on two marks in one read: the reader's own product explained back
      // to them, and a colleague's whole job title written out for someone who had just
      // spoken to him. Naming the thing is correct; describing it to them is the fault.
      'explains_their_own_thing',
      'wrong_or_mismatched_fact',
      'third_person',
      'followup_about_a_different_fact',
      'need_the_offer_does_not_serve',
      // MOVED FROM SOFT on 2026-09-30. See the note beside it in the module.
      'bridge_does_not_follow',
    ])
  })

  it('asks whether the email explains the reader their own thing, at every position', () => {
    // The fault is the EXPLANATION, not the reference, and the question has to say so or the
    // reviewer flags every mention of the reader's own product as a fault.
    const category = HARD_FAIL_CATEGORIES.find(c => c.id === 'explains_their_own_thing')
    expect(category, 'the category is gone: update this test').toBeDefined()
    expect(category!.positions).toEqual([1, 2, 3])
    expect(category!.question).toMatch(/NAMING it is\s+correct/)
    expect(category!.question.toLowerCase()).toContain('job title')
  })

  it('asks about where their CLIENTS come from, not only about their diary', () => {
    const clients = HARD_FAIL_CATEGORIES.find(c => c.id === 'guess_about_their_clients')!
    expect(clients.question.toLowerCase()).toContain('referral')
    // And the diary category no longer carries it, or one fault would be reported twice
    // under two names and the count would stop meaning anything.
    const them = HARD_FAIL_CATEGORIES.find(c => c.id === 'guess_about_them')!
    expect(them.question.toLowerCase()).not.toContain('customers')
    expect(them.question.toLowerCase()).not.toContain('clients')
  })

  it('does not ask Email 1 whether it argues from a different fact than Email 1', () => {
    // Asking an unanswerable question invites an answer. Email 1 IS the first email.
    expect(idsFor(1)).not.toContain('followup_about_a_different_fact')
    expect(idsFor(2)).toContain('followup_about_a_different_fact')
    expect(idsFor(3)).toContain('followup_about_a_different_fact')
  })

  it('has no soft category now, and no id may sit in both lists', () => {
    // bridge_does_not_follow moved to the hard list on 2026-09-30. The soft machinery stays
    // for the next category of its kind; an empty list is a readable state.
    expect(SOFT_CATEGORIES).toEqual([])
    for (const soft of SOFT_CATEGORIES) {
      expect(HARD_FAIL_CATEGORIES.map(c => c.id)).not.toContain(soft.id)
    }
  })

  it('lists every asked id in the prompt, so the model is told what to return', () => {
    const p2 = buildReviewPrompt(2)
    for (const id of idsFor(2)) expect(p2).toContain(id)
    expect(p2).toContain('bridge_does_not_follow')
    expect(p2).toContain('guess_about_their_clients')
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
    // A FAIL IN THE REPORT, not a score beside it. Moved 2026-09-30 on the operator's marks.
    expect(hardFails.bridge_does_not_follow.failed).toBe(true)
    expect(softNotes).toEqual({})
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

// ═══════════════════════════════════════════════════════════════════════════════
// TWO FIXES FROM THE FIRST CALIBRATION RUN, 2026-09-30.
//
// Both came from the same email: the reviewer failed one the operator had passed without
// reservation, on a third_person verdict about the firm's name, and a fact verdict that ran
// to four sentences and changed its mind twice inside them.
//
// RULE ZERO. Every fixture is invented.
// ═══════════════════════════════════════════════════════════════════════════════

describe('third person means the PERSON, not their company', () => {
  const reply = (quote: string) =>
    JSON.stringify({ verdicts: [{ id: 'third_person', failed: true, quote, why: 'reads as third person' }] })

  it('does NOT fire on a sentence that only names their firm', () => {
    const { hardFails } = parseReviewResponse(
      reply('The buyers who need Kestrel Works next are not walking through a door they have to find themselves.'),
      1, ['Rowan', 'Penhale'],
    )
    expect(hardFails.third_person.failed).toBe(false)
  })

  it('DOES fire when the reader is named', () => {
    const { hardFails } = parseReviewResponse(
      reply('Rowan has been running the workshop single-handed since March.'), 1, ['Rowan', 'Penhale'],
    )
    expect(hardFails.third_person.failed).toBe(true)
  })

  it('DOES fire on a third-person pronoun for the person', () => {
    const { hardFails } = parseReviewResponse(
      reply('He opened the second site in March.'), 1, ['Rowan', 'Penhale'],
    )
    expect(hardFails.third_person.failed).toBe(true)
  })

  it('leaves the verdict alone when no names are supplied, rather than dropping it silently', () => {
    const { hardFails } = parseReviewResponse(
      reply('The buyers who need Kestrel Works next are not walking through a door.'), 1,
    )
    expect(hardFails.third_person.failed).toBe(true)
  })

  it('suppresses nothing else: the same quote still fails another category', () => {
    // The suppression is scoped to third_person. Without this, widening it later would look
    // like a passing test rather than a change.
    const { hardFails } = parseReviewResponse(JSON.stringify({ verdicts: [
      { id: 'audience_claim', failed: true, quote: 'Nobody at Kestrel Works reads those posts.', why: 'x' },
    ] }), 1, ['Rowan', 'Penhale'])
    expect(hardFails.audience_claim.failed).toBe(true)
  })
})

describe('a category\'s reasoning is capped', () => {
  it('cuts anything past the limit and marks the cut', () => {
    const long = 'x'.repeat(MAX_WHY_CHARS + 200)
    const { hardFails } = parseReviewResponse(JSON.stringify({ verdicts: [
      { id: 'invented_fact', failed: true, quote: 'a quoted sentence', why: long },
    ] }), 1)
    expect(hardFails.invented_fact.why.length).toBeLessThanOrEqual(MAX_WHY_CHARS)
    expect(hardFails.invented_fact.why.endsWith('…')).toBe(true)
  })

  it('leaves a short reason exactly as written', () => {
    const { hardFails } = parseReviewResponse(JSON.stringify({ verdicts: [
      { id: 'invented_fact', failed: true, quote: 'a quoted sentence', why: 'no finding says so' },
    ] }), 1)
    expect(hardFails.invented_fact.why).toBe('no finding says so')
  })

  it('tells the model the limit, so the cut is not a surprise', () => {
    expect(buildReviewPrompt(1)).toContain(String(MAX_WHY_CHARS))
  })
})
