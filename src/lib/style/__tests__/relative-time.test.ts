// A RELATIVE TIME WORD MUST MATCH THE EVENT'S REAL DATE.
//
// Measured 2026-09-24: an Email 1 said "last month" about an event from 1 May, on a run
// date of 24 September. Four months. Fixtures are industry-neutral.

import { describe, it, expect } from 'vitest'
import { findRelativeTimeFaults, relativeTimeFeedback, monthsAgo, parseFindingDate } from '../relative-time'
import { splitIntoSentences } from '../sentence-count'

const NOW = new Date('2026-09-24T00:00:00Z')
const split = (t: string) => splitIntoSentences(t)

describe('monthsAgo', () => {
  it('counts whole months, and reads a year-only or year-month date', () => {
    expect(monthsAgo('2026-05-01', NOW)).toBe(4)
    expect(monthsAgo('2026-09', NOW)).toBe(0)
    expect(monthsAgo('2025', NOW)).toBe(20)
    expect(monthsAgo(null, NOW)).toBeNull()
    expect(monthsAgo('not a date', NOW)).toBeNull()
  })
})

describe('findRelativeTimeFaults', () => {
  const candidates = [
    { date: '2026-05-01', observation: 'The firm shared an announcement about a new partnership on 1 May 2026.' },
    { date: '2026-09-10', observation: 'The founder posted about a hiring round on 10 September 2026.' },
  ]

  it('rejects "last month" about an event four months old', () => {
    const f = findRelativeTimeFaults('You shared the partnership announcement last month.', candidates, NOW, split)
    expect(f).toHaveLength(1)
    expect(f[0].actualMonths).toBe(4)
    expect(relativeTimeFeedback(f[0])).toContain('4 months ago')
  })

  it('ACCEPTS the same phrase about an event that really was last month', () => {
    // POSITIVE CONTROL. Without it the rule would be satisfied by banning relative time,
    // and "last month" is good plain copy when true.
    expect(findRelativeTimeFaults('You posted about the hiring round last month.', candidates, NOW, split)).toEqual([])
  })

  it('reads the windows generously, because ordinary speech is not exact', () => {
    // "recently" tolerates six months, so the four-month event passes.
    expect(findRelativeTimeFaults('You shared the partnership announcement recently.', candidates, NOW, split)).toEqual([])
    // "this week" does not.
    expect(findRelativeTimeFaults('You shared the partnership announcement this week.', candidates, NOW, split)).toHaveLength(1)
  })

  it('matches per sentence, so one wrong phrase does not condemn the email', () => {
    const text = 'You posted about the hiring round last month.\n\nYou shared the partnership announcement last month.'
    const f = findRelativeTimeFaults(text, candidates, NOW, split)
    expect(f).toHaveLength(1)
    expect(f[0].sentence).toContain('partnership')
  })

  it('FAILS OPEN when no candidate resembles the sentence', () => {
    // Demanding a date from an unrelated row is how the event-year gate produced demands no
    // rewrite could satisfy. An untraceable claim is the traceability check's problem.
    expect(findRelativeTimeFaults('You sponsored a youth team last month.', candidates, NOW, split)).toEqual([])
  })

  it('says nothing about copy with no relative time word, or no dated candidate', () => {
    expect(findRelativeTimeFaults('You shared the partnership announcement in May 2026.', candidates, NOW, split)).toEqual([])
    expect(findRelativeTimeFaults('You shared it last month.', [{ date: null, observation: 'x' }], NOW, split)).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// A DATE THAT LOOKS PARSEABLE AND IS NOT. Added 2026-09-30.
//
// Handing a free-text date to new Date() does not fail loudly, it guesses, and the guess can
// be years out. Measured on the uploaded cohort: one prospect's chosen finding carries the
// date "September 12-17, 2026", which new Date() reads as 2017-09-12 because it takes the
// "-17" as the year. The copy said "last month" about a September burst and the gate reported
// it 108 MONTHS out: the copy was right, the gate was wrong, and wrong in the direction that
// costs a personalised email.
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseFindingDate refuses what new Date() would guess at', () => {
  it('reads the forms we actually write', () => {
    expect(parseFindingDate('2026-09-12')?.toISOString().slice(0, 10)).toBe('2026-09-12')
    expect(parseFindingDate('2026-09')?.toISOString().slice(0, 10)).toBe('2026-09-01')
    expect(parseFindingDate('2026')?.toISOString().slice(0, 10)).toBe('2026-01-01')
    expect(parseFindingDate('2026-09-12T10:00:00Z')?.toISOString().slice(0, 10)).toBe('2026-09-12')
  })

  it('REFUSES the range that new Date() misreads by nine years', () => {
    // The control for the whole change: prove the old behaviour was wrong before trusting
    // that the new one is right.
    expect(new Date('September 12-17, 2026').getUTCFullYear()).toBe(2017)
    expect(parseFindingDate('September 12-17, 2026')).toBeNull()
  })

  it('refuses every other free-text form rather than guessing', () => {
    for (const raw of ['12 September 2026', 'Sept 2026', 'Q3 2026', 'summer 2026', '']) {
      expect(parseFindingDate(raw), raw).toBeNull()
    }
    expect(parseFindingDate(null)).toBeNull()
    expect(parseFindingDate(undefined)).toBeNull()
  })

  it('makes the gate FAIL OPEN on such a finding, rather than measuring the wrong event', () => {
    const candidates = [{ date: 'September 12-17, 2026', observation: 'The insights page published twelve articles in six days.' }]
    const faults = findRelativeTimeFaults(
      'Your insights page ran twelve new articles in six days last month.',
      candidates, new Date('2026-09-30T00:00:00Z'), splitIntoSentences,
    )
    expect(faults).toEqual([])
  })
})
