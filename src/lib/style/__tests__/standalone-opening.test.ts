// Does a fallback opening paragraph read as a first line?
//
// RULE ZERO NOTE ON THE FIXTURES. Every paragraph below is invented for this test and names
// no industry, buyer type, sector, company or client. The real paragraph that prompted this
// check is deliberately NOT reproduced: it names a sector, and a fixture is copyable. What is
// reproduced is its SHAPE, which is the thing the check is about.

import { describe, it, expect } from 'vitest'
import {
  findStandaloneOpeningFaults,
  readsAsStandaloneOpening,
} from '../standalone-opening'

describe('findStandaloneOpeningFaults', () => {
  // ── THE CONTROL COMES FIRST ────────────────────────────────────────────────
  //
  // A check that flags everything is not a check. If these stopped passing, every assertion
  // below would still pass while meaning nothing.
  describe('paragraphs that do read as an opening line', () => {
    const clean = [
      'Your team published four case studies last quarter and each one names a different buyer.',
      'Most teams of your size run outreach and delivery from the same two calendars.',
      'You have three open roles listed and no one running the pipeline behind them.',
      'Hiring slows down in the month after a big launch.',
    ]

    for (const paragraph of clean) {
      it(`accepts: ${paragraph.slice(0, 45)}...`, () => {
        expect(findStandaloneOpeningFaults(paragraph)).toEqual([])
        expect(readsAsStandaloneOpening(paragraph)).toBe(true)
      })
    }
  })

  // ── THE SHAPE THAT SHIPPED ────────────────────────────────────────────────
  //
  // A paragraph written to FOLLOW an observation: it points at a situation the reader has
  // not been told about. With research, the slot above it is replaced and the reference
  // resolves. Without research this is the first line, and it opens mid-thought.
  it('rejects a paragraph that points back at an unnamed situation', () => {
    const findings = findStandaloneOpeningFaults(
      'Where this tends to show up is in the third month of a quarter.',
    )
    expect(findings.length).toBeGreaterThan(0)
    expect(findings.some(f => f.kind === 'points_backwards')).toBe(true)
  })

  it('rejects a demonstrative binding a noun that was never named', () => {
    const findings = findStandaloneOpeningFaults(
      'That pattern repeats every time a large project lands.',
    )
    expect(findings.some(f => f.kind === 'points_backwards')).toBe(true)
    expect(findings.some(f => f.phrase.toLowerCase().includes('pattern'))).toBe(true)
  })

  it('rejects a bare pronoun with nothing in front of it', () => {
    const findings = findStandaloneOpeningFaults('They rarely notice until renewal comes round.')
    expect(findings.some(f => f.kind === 'points_backwards')).toBe(true)
  })

  // ── THE OTHER FAULT: a missing CLAUSE rather than a missing NOUN ───────────
  it.each([
    ['But the calendar fills up before anyone notices.', 'but'],
    ['So the work lands on whoever answered last.', 'so'],
    ['Instead, the follow-up waits until someone has a spare afternoon.', 'instead'],
    ['Which is why the second month always looks thin.', 'which'],
  ])('rejects an opener that presupposes an earlier sentence: %s', (paragraph, word) => {
    const findings = findStandaloneOpeningFaults(paragraph)
    expect(findings.some(f => f.kind === 'presupposes_earlier_sentence')).toBe(true)
    expect(findings.some(f => f.phrase === word)).toBe(true)
  })

  // ── THE DISPLACEMENT IS LOAD-BEARING ──────────────────────────────────────
  //
  // findBackReferences exempts its FIRST content paragraph, so without the placeholder this
  // function would scan nothing and return clean on every input. That would be a check that
  // runs, reports success, and never reaches what it is checking, which is the exact shape
  // CLAUDE.md warns about. This test fails if the placeholder is ever removed.
  it('scans the paragraph itself rather than exempting it as a replaced slot', () => {
    const pointsBack = 'Those conversations stop happening once the calendar fills.'
    expect(findStandaloneOpeningFaults(pointsBack).length).toBeGreaterThan(0)
  })

  it('returns nothing for an empty or whitespace paragraph rather than throwing', () => {
    expect(findStandaloneOpeningFaults('')).toEqual([])
    expect(findStandaloneOpeningFaults('   \n  ')).toEqual([])
  })

  // ── INDUSTRY AGNOSTIC BY CONSTRUCTION ─────────────────────────────────────
  //
  // The same sentence shape is judged the same way whatever the subject matter, which is
  // what makes this a check on English rather than a rule about one client's copy.
  it('judges the same structure identically across unrelated subject matter', () => {
    const shapes = [
      'That backlog grows quietly between releases.',
      'That fleet spends more time idle than moving.',
      'That ward runs short of beds every winter.',
    ]
    const verdicts = shapes.map(s => findStandaloneOpeningFaults(s).length > 0)
    expect(verdicts).toEqual([true, true, true])
  })
})
