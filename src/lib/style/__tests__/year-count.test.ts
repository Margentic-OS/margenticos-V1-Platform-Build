// A COUNT OF YEARS IS ARITHMETIC AND THE MODEL MUST NOT DO IT.
//
// Measured 2026-09-24: one prospect's Email 1 subject said twelve years and his Email 3
// said thirteen, about a firm founded fourteen years earlier, with the founding date on the
// same database row. Two numbers, one prospect, one run, neither right.
//
// Fixtures are industry-neutral. The three real shapes that decided the rule are reproduced
// here as synthetic equivalents; the real ones are checked in a gitignored script.

import { describe, it, expect } from 'vitest'
import { findYearCounts, elapsedYears, findYearCountFaults } from '../year-count'

const NOW = new Date('2026-09-24T00:00:00Z')

describe('findYearCounts', () => {
  it('reads numerals and words, which is why both wrong figures were caught', () => {
    expect(findYearCounts('Thirteen years running it solo.')).toEqual([{ phrase: 'Thirteen years', years: 13 }])
    expect(findYearCounts('12 years of past performance.')).toEqual([{ phrase: '12 years', years: 12 }])
    expect(findYearCounts('a 19-year anniversary')).toEqual([{ phrase: '19-year', years: 19 }])
  })

  it('leaves VAGUE durations alone, because they make no checkable claim', () => {
    expect(findYearCounts('over a decade of it')).toEqual([])
    expect(findYearCounts('for years now')).toEqual([])
    expect(findYearCounts('a long time')).toEqual([])
  })
})

describe('elapsedYears', () => {
  it('floors to the anniversary, the way a person counts', () => {
    expect(elapsedYears('2012-09-01', NOW)).toBe(14)
    // Three weeks before the anniversary is still thirteen.
    expect(elapsedYears('2012-10-15', NOW)).toBe(13)
    expect(elapsedYears('2026-09-16', NOW)).toBe(0)
  })

  it('accepts a year-only date and returns null for no date or nonsense', () => {
    expect(elapsedYears('2025', NOW)).toBe(1)
    expect(elapsedYears(null, NOW)).toBeNull()
    expect(elapsedYears('not a date', NOW)).toBeNull()
  })
})

describe('findYearCountFaults', () => {
  // SHAPE 1: a founding date, and findings prose carrying a STALE figure beside it. The
  // date is right and the sentence is wrong, and the copy repeated the sentence.
  const staleProse = [
    { date: '2012-09-01', observation: 'The founder has run the firm alone for over 13 years with no co-founder in the record.' },
    { date: null, observation: 'A 13-year-old firm just earned a new certification.' },
  ]

  it('rejects a count that disagrees with a dated finding, even when the findings SAY it', () => {
    // The case the rule exists for. "13" appears in the findings twice, and is still wrong.
    const f = findYearCountFaults('Thirteen years running it solo.', staleProse, NOW)
    expect(f).toHaveLength(1)
    expect(f[0]).toContain('disagrees with the dates')
    expect(f[0]).toContain('14')
  })

  it('rejects a count that matches neither a date nor the findings prose', () => {
    expect(findYearCountFaults('Twelve years of past performance.', staleProse, NOW)).toHaveLength(1)
  })

  it('ACCEPTS the count the arithmetic actually gives', () => {
    // POSITIVE CONTROL. Without it this gate would be satisfied by banning the construction.
    expect(findYearCountFaults('Fourteen years running it solo.', staleProse, NOW)).toEqual([])
  })

  // SHAPE 2: the findings STATE a duration that no date implies, because every date on the
  // row is a publication date. Arithmetic from those dates is zero and means nothing.
  const statedInProse = [
    { date: '2026-09-16', observation: 'The founder published a 19-year anniversary piece on September 16, 2026.' },
    { date: '2026-06-30', observation: 'The founder reshared a third-party article on June 30, 2026.' },
  ]

  it('accepts a count the findings state outright, when no date is describing the same thing', () => {
    expect(findYearCountFaults('Nineteen years of subscribers already know the name.', statedInProse, NOW)).toEqual([])
  })

  it('still rejects a different count on the same findings', () => {
    // The other half: accepting 19 must not accept any number.
    expect(findYearCountFaults('Nine years of subscribers already know the name.', statedInProse, NOW)).toHaveLength(1)
  })

  // SHAPE 3: the count is the LENGTH OF AN ENUMERATION of years, stated nowhere as a number.
  const enumerated = [
    { date: '2025', observation: 'The firm is listed as a top supplier for 2023, 2024, and 2025.' },
    { date: '2026-08-01', observation: 'The founder reshared a launch announcement on 1 August 2026.' },
  ]

  it('accepts a count equal to the length of a year enumeration in the findings', () => {
    expect(findYearCountFaults('Three years running on that list.', enumerated, NOW)).toEqual([])
  })

  it('a YEAR-ONLY date widens what is allowed and never narrows it', () => {
    // THE BUG THIS PINS. A year-only date knows no month, so it admits the value either
    // side. If that slack were also allowed to OVERRIDE a findings-stated count, the
    // enumeration above would be rejected on the authority of a date that does not know its
    // own month. Measured: that is exactly what happened before the two sets were split.
    expect(findYearCountFaults('Two years on that list.', enumerated, NOW)).toEqual([])
    expect(findYearCountFaults('Three years running on that list.', enumerated, NOW)).toEqual([])
  })

  it('rejects any count when the findings carry no date and no figure', () => {
    const undated = [{ date: null, observation: 'The website lists a named senior role.' }]
    const f = findYearCountFaults('Ten years of doing it.', undated, NOW)
    expect(f).toHaveLength(1)
    expect(f[0]).toContain('no dated finding behind it')
  })

  it('says nothing about copy that states no count', () => {
    expect(findYearCountFaults('You opened a second site in March.', staleProse, NOW)).toEqual([])
  })
})
