// THE YEAR RULE. An event from another year must say which year.
//
// POSITIVE CONTROLS BOTH WAYS throughout: every case that must fail is paired with the
// nearest case that must pass. A gate tested only on what it rejects is indistinguishable
// from a gate that rejects everything, which is an outage rather than a control.

import { describe, it, expect } from 'vitest'
import { eventYear, missingEventYear, eventYearGateMessage } from '../event-year'

const NOW = new Date('2026-09-23T12:00:00Z')

describe('eventYear reads the year out of a date string', () => {
  it.each([
    ['2025-07-24', 2025],
    ['2025-07', 2025],
    ['2025', 2025],
    ['July 24, 2025', 2025],
    ['1998-10-01', 1998],
    // A RANGE TAKES ITS START, the year furthest from now, which is the stronger
    // requirement to name.
    ['2021-01-01 to 2023-01-01', 2021],
  ])('%s -> %s', (given, expected) => {
    expect(eventYear(given)).toBe(expected)
  })

  it.each([[null], [undefined], [''], ['approximate: last spring'], ['undated']])(
    '%s has no year', given => {
      expect(eventYear(given as string | null)).toBeNull()
    })
})

describe('the rule fires on a prior-year event that hides its year', () => {
  it('THE CASE THAT MOTIVATED IT: a July 2025 webinar written as "in July"', () => {
    const observation = 'You co-hosted a webinar in July on the One Big Beautiful Bill.'
    expect(missingEventYear(observation, '2025-07-24', NOW)).toBe(2025)
  })

  it('and passes the moment the same sentence names the year', () => {
    const observation = 'You co-hosted a webinar in July 2025 on the One Big Beautiful Bill.'
    expect(missingEventYear(observation, '2025-07-24', NOW)).toBeNull()
  })

  it('fires however old the event is', () => {
    expect(missingEventYear('You have run 8 Consulting as its sole principal.', '2012-09-01', NOW)).toBe(2012)
  })

  it('and a long-tenure observation that names its year passes, so the rule is not a recency floor', () => {
    const observation = 'You have run 8 Consulting as its sole principal since September 2012.'
    expect(missingEventYear(observation, '2012-09-01', NOW)).toBeNull()
  })
})

describe('the rule stays silent where it should', () => {
  it('a CURRENT-year event needs no year, which is most of the corpus', () => {
    expect(missingEventYear('You posted the HR Generalist search in July.', '2026-07-23', NOW)).toBeNull()
  })

  it('even a current-year event at the very start of the year', () => {
    expect(missingEventYear('You spoke in January.', '2026-01-02', NOW)).toBeNull()
  })

  it('an UNDATED candidate is out of scope: inventing a year would be worse than silence', () => {
    expect(missingEventYear('You appeared on episode 105.', null, NOW)).toBeNull()
    expect(missingEventYear('You appeared on episode 105.', 'undated', NOW)).toBeNull()
  })

  it('the year may appear anywhere in the observation, not only beside the month', () => {
    expect(missingEventYear('In 2025 you co-hosted a webinar on federal contracting.', '2025-07-24', NOW)).toBeNull()
  })

  it('a two-digit year does NOT satisfy it, and that is deliberate', () => {
    // "'25" is ambiguous in an email that may also carry other numbers, and the gate is
    // here precisely because an unclear date reads as a recent one.
    expect(missingEventYear("You co-hosted a webinar in July '25.", '2025-07-24', NOW)).toBe(2025)
  })

  it('the rule moves with the clock rather than pinning a year in code', () => {
    const obs = 'You co-hosted a webinar in July.'
    expect(missingEventYear(obs, '2025-07-24', new Date('2025-11-01T00:00:00Z'))).toBeNull()
    expect(missingEventYear(obs, '2025-07-24', new Date('2026-01-01T00:00:00Z'))).toBe(2025)
  })
})

describe('the gate message is also the retry instruction', () => {
  it('names the year twice: what is missing and what to add', () => {
    const m = eventYearGateMessage(2025)
    expect(m).toContain('2025')
    expect(m).toMatch(/name the year in the observation/)
    // It must say what to do, not only what is wrong. A gate that reports a failure and
    // leaves the writer to guess burns attempts, which is how Kit lost three of them.
    expect(m).toMatch(/cutting something else/)
  })
})
