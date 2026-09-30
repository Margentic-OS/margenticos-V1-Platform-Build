// DEFINING A GROUP BY WHAT IT DOES NOT KNOW IS NOT A CLAIM ABOUT THE MARKET.
//
// The operator's distinction, encoded. Two sentences sharing almost every word:
//
//   ALLOWED  "Buyers who have never heard of <firm> won't find this on their own."
//   A CLAIM  "Buyers have not heard of <firm> yet."
//
// The first is true by construction and still true if the group is empty. The second asserts
// a present state of awareness across a market nobody has measured.
//
// WHY IT MATTERS MORE THAN A RARE SHAPE: the permitted form is the most common bridge in the
// corpus, and the Email 1 fact-check rejected it. Measured 2026-09-28, five prospects were
// templated on stranger lines and one of those five was the permitted form.
//
// RULE ZERO. Every fixture is invented.

import { describe, it, expect } from 'vitest'
import { isStrangerGroupStatement } from '../stranger-group'

describe('the permitted form: a defining clause plus a future modal', () => {
  it('accepts the operator\'s own example', () => {
    expect(isStrangerGroupStatement("Buyers who have never heard of Kestrel Works won't find this on their own.")).toBe(true)
  })

  it('accepts it with the clauses swapped, which is the same sentence', () => {
    expect(isStrangerGroupStatement('It will not reach the buyers who have never come across the firm.')).toBe(true)
  })

  it('accepts the other modals and the other acquaintance verbs', () => {
    expect(isStrangerGroupStatement('Leaders who have not yet met the team cannot ask for it by name.')).toBe(true)
    expect(isStrangerGroupStatement('Owners who have never read those posts are unlikely to search for them.')).toBe(true)
    expect(isStrangerGroupStatement('Firms that have never dealt with the practice will not think of it first.')).toBe(true)
  })
})

describe('the asserting form, and the near misses', () => {
  it('rejects a present state of awareness with no defining clause', () => {
    expect(isStrangerGroupStatement('Buyers have not heard of Kestrel Works yet.')).toBe(false)
  })

  it('rejects a defining clause with NO modal, which asserts who they are', () => {
    // "are the ones worth reaching" is a claim about that group, not a statement of what
    // they will not do.
    expect(isStrangerGroupStatement('Buyers who have never heard of the firm are the ones worth reaching.')).toBe(false)
  })

  it('rejects a modal with NO defining clause, which is about all buyers', () => {
    expect(isStrangerGroupStatement("Buyers won't find this on their own.")).toBe(false)
  })

  it('rejects the asserting form with a modal bolted on after it', () => {
    // ORDER IS CHECKED. Here the relative clause is about the CONSEQUENCE, not the group, so
    // the not-knowing sits before the pronoun and this is the asserting form in disguise.
    expect(isStrangerGroupStatement("Buyers have not heard of the firm, which means they won't find this.")).toBe(false)
  })

  it('rejects a present-tense state even when it names a group', () => {
    expect(isStrangerGroupStatement('Those buyers are not reading the posts.')).toBe(false)
  })

  it('rejects an ordinary sentence, and empty input', () => {
    expect(isStrangerGroupStatement('You opened a second workshop in March.')).toBe(false)
    expect(isStrangerGroupStatement('')).toBe(false)
  })
})
