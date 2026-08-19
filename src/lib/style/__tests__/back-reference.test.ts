// Unit tests for findBackReferences.
//
// The anchor is the real variant D P3 that shipped and broke:
//   "We break that ceiling by running outbound that puts the right conversations in
//    your diary."
// It must hard-fail. The counterpart anchor is variant A's P3, which uses a definite
// article and is perfectly good copy:
//   "We get qualified meetings into your diary without you touching the outreach."
// It must NOT fail.

import { describe, it, expect } from 'vitest'
import { findBackReferences, contentParagraphs } from '../back-reference'

const withFrame = (...paras: string[]) => ['{{first_name}}', ...paras].join('\n\n')

const VARIANT_D_EMAIL1 = withFrame(
  "Referrals feel like the safe channel. But they're not a pipeline. They're a ceiling. The size of your network sets your revenue cap and you can't outwork it or speed it up.",
  'We break that ceiling by running outbound that puts the right conversations in your diary.',
  'Is that the constraint you\'re bumping into?',
  'Doug\nMargenticOS',
)

const VARIANT_A_EMAIL1 = withFrame(
  'A project ends and the diary empties. No referrals lined up, no outreach running, nothing queued.',
  'We get qualified meetings into your diary without you touching the outreach.',
  "Is this something you're actively trying to fix?",
  'Doug\nMargenticOS',
)

describe('the two anchor cases', () => {
  it('hard-fails variant D P3 on "that ceiling"', () => {
    const r = findBackReferences(VARIANT_D_EMAIL1)
    expect(r.demonstratives).toHaveLength(1)
    expect(r.demonstratives[0].phrase).toBe('that ceiling')
  })

  it('reports the D hit at P3, matching the documented frame', () => {
    // P1 greeting, P2 slot, P3 what changes. The hit is in P3.
    expect(findBackReferences(VARIANT_D_EMAIL1).demonstratives[0].paragraph).toBe(3)
  })

  it('does NOT fail variant A, whose P3 uses an ordinary definite article', () => {
    expect(findBackReferences(VARIANT_A_EMAIL1).demonstratives).toEqual([])
  })

  it('still reports "the outreach" as a definite article without gating on it', () => {
    const r = findBackReferences(VARIANT_A_EMAIL1)
    expect(r.definiteArticles.map(d => d.phrase)).toContain('the outreach')
    expect(r.demonstratives).toEqual([])
  })
})

describe('the demonstrative hard gate', () => {
  it.each([
    ['that ceiling', 'We break that ceiling by running outbound.'],
    ['this pattern', 'We stop this pattern before it costs you a quarter.'],
    ['those meetings', 'We fill those meetings for you.'],
    ['these firms', 'We work with these firms every week.'],
    ['such firms', 'We build pipeline for such firms routinely.'],
  ])('fails on "%s"', (phrase, p3) => {
    const r = findBackReferences(withFrame('An opener.', p3))
    expect(r.demonstratives.map(d => d.phrase)).toContain(phrase)
  })

  it('exempts paragraph 2, the slot itself', () => {
    // A demonstrative inside P2 can only point at P2's own text, which always ships
    // together with it.
    const r = findBackReferences(withFrame('They are a ceiling. That ceiling caps revenue.', 'We run the outbound.'))
    expect(r.demonstratives).toEqual([])
  })
})

describe('false positives that must not fire', () => {
  it('allows "that" as a relative pronoun', () => {
    const r = findBackReferences(withFrame('An opener.', 'We run outbound that puts conversations in your diary.'))
    expect(r.demonstratives).toEqual([])
  })

  it('allows "that" as a complementiser', () => {
    const r = findBackReferences(withFrame('An opener.', 'Most founders find that doing more outreach never fixes it.'))
    expect(r.demonstratives).toEqual([])
  })

  it('allows "Does that sound like where you are?"', () => {
    const r = findBackReferences(withFrame('An opener.', 'Does that sound like where you are?'))
    expect(r.demonstratives).toEqual([])
  })

  it('allows the contraction "that\'s"', () => {
    const r = findBackReferences(withFrame('An opener.', "If the timing is off, that's fair."))
    expect(r.demonstratives).toEqual([])
  })

  it('allows "is this something you\'re trying to fix"', () => {
    const r = findBackReferences(withFrame('An opener.', "Is this something you're actively trying to fix?"))
    expect(r.demonstratives).toEqual([])
  })

  it('allows "such as"', () => {
    const r = findBackReferences(withFrame('An opener.', 'Channels such as referrals stall without warning.'))
    expect(r.demonstratives).toEqual([])
  })

  it('allows idiomatic stage and position references', () => {
    const r = findBackReferences(withFrame('An opener.', 'Most founders at this stage and in that position see it.'))
    expect(r.demonstratives).toEqual([])
  })

  it('allows "Fixing that first is what makes the meetings qualified."', () => {
    const r = findBackReferences(withFrame('An opener.', 'Fixing that first is what makes the meetings qualified.'))
    expect(r.demonstratives).toEqual([])
  })
})

describe('contentParagraphs', () => {
  it('drops the greeting so P2 is index 0', () => {
    const paras = contentParagraphs(withFrame('The slot.', 'What changes.'))
    expect(paras).toEqual(['The slot.', 'What changes.'])
  })

  it('handles a greeting written with a trailing comma', () => {
    const paras = contentParagraphs('{{first_name}},\n\nThe slot.')
    expect(paras).toEqual(['The slot.'])
  })
})

describe('definite articles are report only', () => {
  it('collects them but never adds a demonstrative violation', () => {
    const r = findBackReferences(withFrame('An opener.', 'We close the gap between the projects.'))
    expect(r.definiteArticles.length).toBeGreaterThan(0)
    expect(r.demonstratives).toEqual([])
  })

  it('ignores the slot paragraph for articles too', () => {
    const r = findBackReferences(withFrame('The diary empties and the outreach stops.', 'We run it for you.'))
    expect(r.definiteArticles).toEqual([])
  })
})
