// The bridges that shipped on 2026-08-20 passed every structural rule and still read as
// abstract. This counts the named list so the concrete-nouns rule can be checked against
// real output rather than assumed to have worked. It never gates.

import { describe, it, expect } from 'vitest'
import { ABSTRACT_NOUNS, findAbstractNouns, countAbstractNouns } from '../abstract-nouns'

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
