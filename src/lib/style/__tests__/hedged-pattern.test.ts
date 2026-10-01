// The boundary Email 1's bridge is held to in the experiment: a possibility about firms
// like the reader's is allowed, anything about the reader is not.
//
// RULE ZERO. Every fixture is invented and industry-neutral.

import { describe, it, expect } from 'vitest'
import { isHedgedPatternStatement } from '../hedged-pattern'

const NAMES = ['Harbour Print', 'Harbour Print Ltd']

describe('a hedged statement about firms like the reader is recognised', () => {
  it.each([
    'A second press often needs work from customers a shop has not quoted yet.',
    'A new location can take longer to fill than the first one did.',
    'A podcast that builds credibility tends to stop short of booking the next meeting.',
    'New hires usually need client work lined up before they arrive.',
    'A firm in that position may find the next project takes longer to land.',
  ])('allows: %s', sentence => {
    expect(isHedgedPatternStatement(sentence, NAMES)).toBe(true)
  })
})

describe('anything about the reader is refused, hedged or not', () => {
  it('refuses a possibility that says "your"', () => {
    expect(isHedgedPatternStatement('Your second press often needs new work.', NAMES)).toBe(false)
  })

  it('refuses a possibility that says "you" as the object', () => {
    expect(isHedgedPatternStatement('New customers can take a while to find you.', NAMES)).toBe(false)
  })

  it('refuses a possibility that names their company', () => {
    expect(isHedgedPatternStatement('A second press at Harbour Print often needs new work.', NAMES)).toBe(false)
  })

  it('matches the company name whatever its case', () => {
    expect(isHedgedPatternStatement('A second press at HARBOUR PRINT can sit idle.', NAMES)).toBe(false)
  })
})

describe('a flat statement is not a hedged one', () => {
  it('refuses a flat claim about a market', () => {
    expect(isHedgedPatternStatement('A second press needs work the first press never needed.', NAMES)).toBe(false)
  })

  it('does not read "can\'t" as a possibility', () => {
    expect(isHedgedPatternStatement("A shop that size can't fill a second press from referrals.", NAMES)).toBe(false)
  })

  it('does not read the month of May as a possibility', () => {
    expect(isHedgedPatternStatement('A press added in May needs new work by autumn.', NAMES)).toBe(false)
  })

  it('reads "May" as a possibility only as the first word', () => {
    expect(isHedgedPatternStatement('May take longer than the first press did.', NAMES)).toBe(true)
  })

  it('refuses a question, which asserts nothing and is checked on its own terms', () => {
    expect(isHedgedPatternStatement('Can a second press fill itself?', NAMES)).toBe(false)
  })

  it('refuses an empty sentence rather than passing it vacuously', () => {
    expect(isHedgedPatternStatement('', NAMES)).toBe(false)
    expect(isHedgedPatternStatement('   ', NAMES)).toBe(false)
  })
})

describe('the company name list cannot widen the refusal by accident', () => {
  it('ignores a name form of two characters or fewer', () => {
    // "an" would otherwise match inside almost any sentence and refuse everything.
    expect(isHedgedPatternStatement('A second press can sit idle.', ['an'])).toBe(true)
  })

  it('works with no name forms at all', () => {
    expect(isHedgedPatternStatement('A second press can sit idle.')).toBe(true)
  })
})
