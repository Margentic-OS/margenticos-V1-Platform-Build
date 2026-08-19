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

// ─── Bare pronouns whose antecedent can only be in the replaced slot ──────────

describe('unanchored pronouns in P3', () => {
  it('hard-fails the sentence that shipped and broke', () => {
    const body = withFrame(
      'Most consulting founders assume outbound does not work for their kind of business.',
      'We run it differently: hyper-specific targeting, conversations that land with the right people.',
      'Worth a look at whether it fits what you do?',
      'Doug\nMargenticOS',
    )
    const r = findBackReferences(body)
    expect(r.unanchoredPronouns.map(h => h.pronoun)).toContain('it')
    expect(r.unanchoredPronouns[0].paragraph).toBe(3)
  })

  it('passes once the noun is restored', () => {
    const body = withFrame(
      'Most consulting founders assume outbound does not work for their kind of business.',
      'We run outbound differently: hyper-specific targeting, conversations that land with the right people.',
      'Worth a look at whether it fits what you do?',
      'Doug\nMargenticOS',
    )
    expect(findBackReferences(body).unanchoredPronouns).toEqual([])
  })

  it.each(['it', 'they', 'them'])('gates the bare pronoun "%s"', pronoun => {
    const body = withFrame('An opener sentence here.', `We handle ${pronoun} for you.`, 'Doug\nMargenticOS')
    expect(findBackReferences(body).unanchoredPronouns.map(h => h.pronoun)).toContain(pronoun)
  })

  it('documents the known false negative: an unlisted verb reads as an antecedent', () => {
    // "sprinkle" is not in the not-a-noun list, so it is treated as a noun and anchors
    // the pronoun. This is the deliberate bias: a missed hit costs a prompt-level catch,
    // a false hit costs a wrongly rejected variant. Recorded so the tradeoff is explicit
    // rather than discovered later.
    const body = withFrame('An opener sentence here.', 'We sprinkle it across the week.', 'Doug\nMargenticOS')
    expect(findBackReferences(body).unanchoredPronouns).toEqual([])
  })
})

describe('unanchored pronouns: false positives that must not fire', () => {
  it('allows a pronoun anchored by a noun earlier in the same paragraph', () => {
    const body = withFrame(
      'An opener sentence here.',
      'The outreach runs every week and it never stops when a project lands.',
      'Doug\nMargenticOS',
    )
    expect(findBackReferences(body).unanchoredPronouns).toEqual([])
  })

  it('allows expletive "it", which points at nothing by design', () => {
    const body = withFrame('An opener sentence here.', 'It takes about a week to set up.', 'Doug\nMargenticOS')
    expect(findBackReferences(body).unanchoredPronouns).toEqual([])
  })

  it('allows "if it becomes one" where the referent is named in the same paragraph', () => {
    const body = withFrame(
      'An opener sentence here.',
      'Most founders find the gap widens. If it becomes one worth fixing, we can help.',
      'Doug\nMargenticOS',
    )
    expect(findBackReferences(body).unanchoredPronouns).toEqual([])
  })

  it('does not gate P4, where P3 may legitimately supply the antecedent', () => {
    const body = withFrame(
      'An opener sentence here.',
      'We run the outbound for you.',
      'Is that something you are trying to fix?',
      'Doug\nMargenticOS',
    )
    const r = findBackReferences(body)
    expect(r.unanchoredPronouns).toEqual([])
  })

  it('does not gate a relative "that", which is not a back-reference', () => {
    const body = withFrame(
      'An opener sentence here.',
      'We book conversations that land with the right people.',
      'Doug\nMargenticOS',
    )
    expect(findBackReferences(body).unanchoredPronouns).toEqual([])
  })

  it('leaves emails 2 to 4 alone entirely, since only Email 1 P2 is replaced', () => {
    // "It runs, they show up to calls" is good copy in Email 3 and the caller only
    // applies the gate to Email 1, but the detector must not mark it hard either.
    const body = '{{first_name}}\n\nAn opener.\n\nIt runs, they show up to calls.\n\nDoug\nMargenticOS'
    const r = findBackReferences(body)
    // Reported, so a human can see it, but the caller gates Email 1 only.
    expect(r.unanchoredPronouns.length + r.ambiguousPronouns.length).toBeGreaterThan(0)
  })
})
