// THE PROSPECT'S REASON IS GRADED WITH THE NAMES TAKEN OUT.
//
// A reason written for one prospect has to name their firm and their role. Those words are
// long, and they cannot be simplified: the point of them is that they are that company's
// name and not another. A reading-grade formula counts syllables per word, so it charges
// the sentence for being specific, which is the opposite of what the ceiling encourages.
//
// MEASURED on the first three prospects a run reached: 6.9, 9.9 and 10.9 against a ceiling
// of 6, every one dropped. Every email then fell back to the trigger's generic reason and
// line two became identical for everyone matching that trigger, which defeats the purpose
// of having a per-prospect reason at all.
//
// ONLY THE GRADE CHECK CHANGES. The word cap and the claims check still run on the sentence
// as written: a name makes a sentence no longer, and it asserts nothing about the reader.

import { describe, it, expect } from 'vitest'
import { findProspectReasonFaults } from '../synthesize'
import { stripProperNouns } from '@/lib/style/sentence-frames'
import { fleschKincaidGrade } from '@/lib/style/reading-grade'

const passes = (r: string) => findProspectReasonFaults(r).length === 0

describe('a specific, plain reason passes even though it names a firm and a role', () => {
  it.each([
    'EdgeBrook Lane needs new client work to fill the HR Generalist seat.',
    'EdgeBrook Lane is actively hiring, a sign the firm is scaling.',
    'Northbank has a new Controller seat and needs work to fill it.',
  ])('passes: %s', (r) => expect(passes(r)).toBe(true))

  it('and the same sentence FAILS when graded as written, which is the whole point', () => {
    // The correction has to be doing something. Without this, every case above could be
    // passing because it was already under the ceiling.
    const r = 'EdgeBrook Lane is actively hiring, a sign the firm is scaling.'
    expect(fleschKincaidGrade(r)!.grade).toBeGreaterThan(6)
    expect(fleschKincaidGrade(stripProperNouns(r))!.grade).toBeLessThanOrEqual(6)
  })
})

describe('a jargon-heavy reason with no names still fails', () => {
  it.each([
    'Third-party validation is a credibility anchor that makes cold outreach convert higher.',
    'Visibility without a system to convert inbound interest into meetings wastes the exposure.',
  ])('fails: %s', (r) => {
    const faults = findProspectReasonFaults(r)
    expect(faults.some(f => f.includes('reading grade'))).toBe(true)
  })

  it('stripping names does not rescue it, because the hard words are not names', () => {
    const r = 'Third-party validation is a credibility anchor that makes cold outreach convert higher.'
    expect(fleschKincaidGrade(stripProperNouns(r))!.grade).toBeGreaterThan(6)
  })
})

describe('the other two checks are untouched by the correction', () => {
  it('the claims check still runs on the sentence AS WRITTEN', () => {
    expect(findProspectReasonFaults('EdgeBrook Lane is too busy to follow it up.')
      .some(f => f.includes('their_time'))).toBe(true)
  })

  it('the word cap still counts names, because a name makes a sentence no longer', () => {
    const long = 'EdgeBrook Lane and Northbank and Acme and Globex all need new client work to fill seats now.'
    expect(findProspectReasonFaults(long).some(f => f.includes('words'))).toBe(true)
  })
})

describe('stripProperNouns keeps what is not a name', () => {
  it('keeps an ordinary capitalised sentence opener', () => {
    // "More" and "Steady" are ordinary words that happen to start a sentence. Removing them
    // would shorten real sentences and let hard prose through.
    expect(stripProperNouns('More staff means more client work.')).toContain('More')
    expect(stripProperNouns('Steady income just stopped.')).toContain('Steady')
  })

  it('removes a multi-word name that STARTS the sentence, both halves of it', () => {
    const out = stripProperNouns('EdgeBrook Lane needs new work.')
    expect(out).not.toContain('EdgeBrook')
    expect(out).not.toContain('Lane')
    expect(out).toContain('needs new work')
  })

  it('keeps sentence boundaries, so the grade is not inflated by joining two sentences', () => {
    const out = stripProperNouns('Acme Corp just lost a retainer. New work is needed now.')
    expect(out.split(/[.!?]/).filter(s => s.trim()).length).toBe(2)
  })

  it('removes a quoted title', () => {
    expect(stripProperNouns('They published "The Quarterly Outlook Review" last week.'))
      .not.toContain('Quarterly')
  })
})
