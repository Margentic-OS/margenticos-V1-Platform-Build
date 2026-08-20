// The bridges that shipped on 2026-08-20 passed every structural rule and still read as
// abstract. This counts the named list so the concrete-nouns rule can be checked against
// real output rather than assumed to have worked. It never gates.

import { describe, it, expect } from 'vitest'
import {
  ABSTRACT_NOUNS, findAbstractNouns, countAbstractNouns,
  FIGURATIVE_VERBS, findFigurativeVerbs, countFigurativeVerbs,
} from '../abstract-nouns'

describe('the named list', () => {
  it('is exactly the eight from the copy review', () => {
    expect([...ABSTRACT_NOUNS].sort()).toEqual(
      ['bandwidth', 'cadence', 'capacity', 'engine', 'flow', 'momentum', 'motion', 'remainder'].sort(),
    )
  })

  it('excludes load and output, which are judgement calls', () => {
    // "a real operational load" is fine; "that output shows" is not. No word list can tell
    // those apart, so both stay a matter for the prompt.
    expect(ABSTRACT_NOUNS).not.toContain('load')
    expect(ABSTRACT_NOUNS).not.toContain('output')
    expect(findAbstractNouns('Running both is a real operational load.')).toEqual([])
  })
})

describe('counting the real failures', () => {
  it('catches the remainder sentence that shipped in Alma Email 1', () => {
    const text = 'That remainder tends to shrink before it grows.'
    expect(findAbstractNouns(text)).toEqual([{ noun: 'remainder', count: 1 }])
  })

  it('catches the engine metaphor that shipped in Makesha Email 1', () => {
    const text = 'The regions that come after tend to need a different engine.'
    expect(findAbstractNouns(text)).toEqual([{ noun: 'engine', count: 1 }])
  })

  it('catches momentum, which shipped in Jochen Email 1', () => {
    const text = 'that pipeline has to run on whatever momentum the last event left behind'
    expect(countAbstractNouns(text)).toBe(1)
  })

  it('scores the concrete standard at zero', () => {
    expect(countAbstractNouns('Delivery has a deadline. Business development never does, so it waits.')).toBe(0)
  })

  it('scores the concrete rewrites at zero', () => {
    expect(countAbstractNouns('A day job and delivery both come first. Outreach gets the hours that are left, and there are fewer of those every week.')).toBe(0)
    expect(countAbstractNouns('The first two markets were built on people you already knew. In the UK you do not know anyone yet, and the introductions have to start from nothing.')).toBe(0)
  })
})

describe('matching is narrow enough to be worth reading', () => {
  it('counts plurals', () => {
    expect(findAbstractNouns('two engines and three flows')).toEqual([
      { noun: 'engine', count: 1 },
      { noun: 'flow', count: 1 },
    ])
  })

  it('does not count a different word that merely starts the same', () => {
    // "engineer" is a job and "flowing" is a verb. Neither is the placeholder noun.
    expect(findAbstractNouns('You hired an engineer. The work is flowing.')).toEqual([])
  })

  it('is case-insensitive', () => {
    expect(countAbstractNouns('Momentum matters')).toBe(1)
  })

  it('counts repeats rather than collapsing them', () => {
    expect(countAbstractNouns('the engine, and the other engine')).toBe(2)
  })

  it('returns nothing for empty input', () => {
    expect(findAbstractNouns('')).toEqual([])
    expect(countAbstractNouns('')).toBe(0)
  })
})


describe('the closing question is copy and must be counted', () => {
  it('catches the flow that shipped in Makesha closing question', () => {
    // The batch report scored this run 0 while this question was live, because the check
    // was pointed at the opening only.
    const q = 'Is building a reliable flow of the right conversations in the UK something you are working through?'
    expect(findAbstractNouns(q)).toEqual([{ noun: 'flow', count: 1 }])
  })

  it('counts opening and question together', () => {
    const opening = 'You registered a UK entity in March.'
    const question = 'Is building a reliable flow of conversations something you are working on?'
    expect(countAbstractNouns(`${opening} ${question}`)).toBe(1)
  })
})


// ─── Figurative verbs ────────────────────────────────────────────────────────
//
// The noun rule held: every noun in the 2026-08-20 batch was concrete. The abstraction moved
// into the verbs and the sentence endings instead.

describe('the named verb list', () => {
  it('is exactly the verbs called out in the copy review', () => {
    expect([...FIGURATIVE_VERBS].sort()).toEqual(
      ['become', 'convert', 'materialise', 'materialize', 'move', 'shrink', 'translate'].sort(),
    )
  })
})

describe('counting the verb failures that shipped', () => {
  it('catches "those tend to shrink before they grow" from Alma', () => {
    expect(findFigurativeVerbs('and those tend to shrink before they grow')).toEqual([
      { verb: 'shrink', count: 1 },
    ])
  })

  it('catches "the thing that moves when something has to" from Bob', () => {
    expect(findFigurativeVerbs('business development is the thing that moves when something has to')).toEqual([
      { verb: 'move', count: 1 },
    ])
  })

  it('catches "before they become a conversation" from Shevonne', () => {
    expect(findFigurativeVerbs('tend to need a nudge before they become a conversation')).toEqual([
      { verb: 'become', count: 1 },
    ])
  })

  it('scores the plain rewrites at zero', () => {
    expect(countFigurativeVerbs('Outreach gets whatever hours are left at the end of the day. Most weeks nobody gets to it.')).toBe(0)
    expect(countFigurativeVerbs('Some of the people who heard it are ready to buy. They will not email you first.')).toBe(0)
  })

  it('scores the filmable standard at zero on both halves of the rule', () => {
    const standard = 'Delivery has a deadline. Business development never does, so it waits.'
    expect(countFigurativeVerbs(standard)).toBe(0)
    expect(countAbstractNouns(standard)).toBe(0)
  })
})

describe('verb matching covers the inflections and nothing else', () => {
  it('catches -s, -ing and -ed', () => {
    expect(countFigurativeVerbs('it moves')).toBe(1)
    expect(countFigurativeVerbs('it is moving')).toBe(1)
    expect(countFigurativeVerbs('it moved')).toBe(1)
    expect(countFigurativeVerbs('it converted')).toBe(1)
  })

  it('catches the irregular became', () => {
    expect(findFigurativeVerbs('it became a conversation')).toEqual([{ verb: 'become', count: 1 }])
  })

  it('does not match a longer unrelated word', () => {
    // "movement" and "shrinkage" are nouns; "conversion" is not in the list at all.
    expect(findFigurativeVerbs('the movement of the market')).toEqual([])
    expect(findFigurativeVerbs('shrinkage in the warehouse')).toEqual([])
  })

  it('is case-insensitive and counts repeats', () => {
    expect(countFigurativeVerbs('Moves and moves again')).toBe(2)
  })

  it('returns nothing for empty input', () => {
    expect(findFigurativeVerbs('')).toEqual([])
    expect(countFigurativeVerbs('')).toBe(0)
  })

  it('reports honestly on a literal use, which is why this never gates', () => {
    // "the deadline moves" is literal and correct copy. The check counts it anyway, and
    // that is the reason nothing acts on the number.
    expect(countFigurativeVerbs('The deadline moves to Friday.')).toBe(1)
  })
})
