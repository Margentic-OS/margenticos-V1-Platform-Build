// A RELATIVE TIME WORD MUST MATCH THE EVENT'S REAL DATE.
//
// Measured 2026-09-24: an Email 1 said "last month" about an event from 1 May, on a run
// date of 24 September. Four months. Fixtures are industry-neutral.

import { describe, it, expect } from 'vitest'
import { findRelativeTimeFaults, relativeTimeFeedback, monthsAgo } from '../relative-time'
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
