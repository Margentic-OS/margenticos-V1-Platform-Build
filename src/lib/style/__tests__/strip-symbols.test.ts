// Trademark, registered and copyright symbols never reach a prospect, and never break a
// company-name match.
//
// The fixtures use the REAL shapes found on the 104 cohort on 2026-09-25, with invented
// names: a framework name carrying the symbol inside a sentence, and a company name carrying
// one. Those are the two directions the symbols arrive from, and a fix that knew about only
// one would pass half of these.
//
// RULE ZERO. Every name here is invented and industry-neutral.

import { describe, it, expect } from 'vitest'
import { stripSymbols, hasSymbols } from '../strip-symbols'
import { companyNameForms } from '../followup-gates'

describe('symbols are removed from anything that ships', () => {
  it('removes trademark, registered, copyright and service mark', () => {
    expect(stripSymbols('Alpha™ Beta® Gamma© Delta℠')).toBe('Alpha Beta Gamma Delta')
  })

  it('removes one inside a sentence without disturbing the words', () => {
    expect(stripSymbols('You published a guide to Reach Equity™ on September 13.'))
      .toBe('You published a guide to Reach Equity on September 13.')
  })

  it('leaves no double space or space before punctuation behind', () => {
    expect(stripSymbols('the Signal™ , released')).toBe('the Signal, released')
    expect(stripSymbols('Alpha™  Beta')).toBe('Alpha Beta')
  })

  it('CONTROL: ordinary text is returned unchanged', () => {
    const plain = 'Two locations were added and four roles listed in the same month.'
    expect(stripSymbols(plain)).toBe(plain)
  })

  it('CONTROL: an emoji in a company name is NOT removed, because it is part of the name', () => {
    expect(stripSymbols('The Operations Company ⚙️')).toBe('The Operations Company ⚙️')
  })

  it('CONTROL: empty survives, and runs of spaces collapse as they do everywhere else', () => {
    expect(stripSymbols('')).toBe('')
    // The collapse is the same rule applied to text that had no symbol in it. Asserted rather
    // than assumed, because it is a side effect of the tidy-up and not the stated purpose.
    expect(stripSymbols('   ')).toBe(' ')
  })
})

describe('hasSymbols is not stateful', () => {
  /**
   * The strip regex carries /g, and RegExp.test on a global regex advances lastIndex and
   * resumes from there. Sharing one instance would make this alternate true/false on the same
   * input, which is worse than having no detector at all.
   */
  it('returns the same answer for the same input, repeatedly', () => {
    const s = 'Reach Equity™'
    expect([hasSymbols(s), hasSymbols(s), hasSymbols(s)]).toEqual([true, true, true])
  })

  it('CONTROL: false on text without one, repeatedly', () => {
    expect([hasSymbols('plain'), hasSymbols('plain')]).toEqual([false, false])
  })

  it('CONTROL: null and undefined are false, not a throw', () => {
    expect(hasSymbols(null)).toBe(false)
    expect(hasSymbols(undefined)).toBe(false)
  })
})

/**
 * COMPANY-NAME MATCHING IS ALREADY SYMBOL-INSENSITIVE, and these tests exist to say so.
 *
 * A strip was added here first, on the reasoning that a company stored as "Focus & Find(R)"
 * would build match forms nothing in the copy could match. MEASURED, and it was wrong:
 * companyNameForms tokenises on non-word characters, so the symbol is already gone before any
 * form is built. Nine shapes were probed, including a symbol mid-name, on an acronym, and on a
 * single-token name, and none produced a form carrying one.
 *
 * The strip was removed rather than left in place with a comment claiming a fix. A mutation
 * test is what caught it: deleting the strip changed nothing, because there was nothing to
 * change. These assertions are kept as the record of that measurement, so the next reader
 * does not add it again.
 */
describe('company-name matching is symbol-insensitive by construction', () => {
  it('a name stored with a registered symbol produces the SAME forms as the plain name', () => {
    const withSymbol = companyNameForms('Focus & Find®')
    const plain = companyNameForms('Focus & Find')
    expect(withSymbol.length).toBeGreaterThan(0)
    expect(withSymbol.some(f => f.includes('®'))).toBe(false)
    // The EQUALITY is the point: matching must not depend on how the name was stored. Asserted
    // against the plain name rather than against a literal, because companyNameForms returns
    // SHORT forms (a leading token, an acronym) and not the whole name, which a literal
    // expectation here got wrong.
    expect(withSymbol).toEqual(plain)
  })

  it('catches a symbol on the LAST token, where the short forms would never reach it', () => {
    const withSymbol = companyNameForms('Vantage Solutions®')
    expect(withSymbol).toEqual(companyNameForms('Vantage Solutions'))
    expect(withSymbol.some(f => f.includes('®'))).toBe(false)
  })

  it('CONTROL: null still returns nothing', () => {
    expect(companyNameForms(null)).toEqual([])
  })
})
