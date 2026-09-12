// The deadline maths, which is the part of the billing lifecycle that cannot be corrected
// later: a wrong deadline bills a client for a meeting before they were told they had to
// answer. Every case here is a calendar edge, not a round number.
//
// MUTATION-PROVED on commit: replacing the calendar deadline with "start plus 60 days" turns
// the month-length and boundary tests red.

import { describe, it, expect } from 'vitest'
import {
  OPERATOR_WARNING_DAYS,
  REMINDER_DAYS_BEFORE_DEADLINE,
  daysUntil,
  formatDeadline,
  reminderDue,
  unconfirmedBillingDeadline,
} from './billing-deadline'

const at = (iso: string) => new Date(iso)

describe('an unconfirmed meeting bills at the end of the following month', () => {
  it.each([
    // meeting                    deadline, the last instant of M+1 in UTC
    ['2026-01-15T14:30:00.000Z', '2026-02-28T23:59:59.999Z'],
    ['2026-01-31T23:00:00.000Z', '2026-02-28T23:59:59.999Z'],
    ['2026-09-12T09:00:00.000Z', '2026-10-31T23:59:59.999Z'],
    ['2026-04-01T00:00:00.000Z', '2026-05-31T23:59:59.999Z'],
    // December rolls into the next year, which is where a naive month + 2 breaks.
    ['2026-12-20T10:00:00.000Z', '2027-01-31T23:59:59.999Z'],
    ['2026-11-30T23:59:00.000Z', '2026-12-31T23:59:59.999Z'],
    // A leap February, so the deadline is the 29th and not the 28th.
    ['2028-01-05T12:00:00.000Z', '2028-02-29T23:59:59.999Z'],
  ])('a meeting at %s bills unconfirmed at %s', (start, expected) => {
    expect(unconfirmedBillingDeadline(at(start)).toISOString()).toBe(expected)
  })

  it('gives a meeting early in the month far longer than one at the end, which is the whole point', () => {
    const early = unconfirmedBillingDeadline(at('2026-03-01T09:00:00.000Z'))
    const late = unconfirmedBillingDeadline(at('2026-03-30T09:00:00.000Z'))

    // Same deadline for both: the window is a calendar date, not a duration.
    expect(early.toISOString()).toBe(late.toISOString())
    expect(daysUntil(early, at('2026-03-01T09:00:00.000Z'))).toBeGreaterThanOrEqual(56) // ~8 weeks
    expect(daysUntil(late, at('2026-03-30T09:00:00.000Z'))).toBeLessThanOrEqual(33) // ~4 weeks
  })

  it('is never in the past for a meeting that has just happened', () => {
    // A meeting at the very last instant of a month still gets the whole of the next month.
    const start = at('2026-06-30T23:59:59.000Z')
    expect(unconfirmedBillingDeadline(start).getTime()).toBeGreaterThan(start.getTime())
  })

  it('reads the meeting time in UTC, not the machine\'s timezone', () => {
    // 23:30 on the 31st in UTC is already the 1st in Sydney. Were this read locally on a
    // machine ahead of UTC, the meeting would fall in the NEXT month and the client would get
    // an extra month to answer. Asserted by value, so it cannot pass by coincidence.
    expect(unconfirmedBillingDeadline(at('2026-07-31T23:30:00.000Z')).toISOString())
      .toBe('2026-08-31T23:59:59.999Z')
  })
})

describe('days remaining', () => {
  it('counts whole days and rounds up, so a deadline today is not reported as zero days early', () => {
    expect(daysUntil(at('2026-10-31T23:59:59.999Z'), at('2026-10-24T09:00:00.000Z'))).toBe(8)
    expect(daysUntil(at('2026-10-31T23:59:59.999Z'), at('2026-10-31T09:00:00.000Z'))).toBe(1)
  })

  it('is zero once the deadline has passed, never negative', () => {
    expect(daysUntil(at('2026-10-31T23:59:59.999Z'), at('2026-11-01T00:00:00.100Z'))).toBe(0)
    expect(daysUntil(at('2026-10-31T23:59:59.999Z'), at('2026-12-25T00:00:00.000Z'))).toBe(0)
  })
})

describe('reminders work back from the real deadline', () => {
  const deadline = at('2026-10-31T23:59:59.999Z')

  it('sends nothing while the deadline is far away', () => {
    expect(reminderDue(deadline, at('2026-10-01T09:00:00.000Z'), 0)).toBeNull()
  })

  it('sends the first reminder two weeks out, the second at one week, the third at two days', () => {
    expect(reminderDue(deadline, at('2026-10-18T09:00:00.000Z'), 0)).toMatchObject({ threshold: 14, index: 0 })
    expect(reminderDue(deadline, at('2026-10-25T09:00:00.000Z'), 1)).toMatchObject({ threshold: 7, index: 1 })
    expect(reminderDue(deadline, at('2026-10-30T09:00:00.000Z'), 2)).toMatchObject({ threshold: 2, index: 2 })
  })

  it('sends each reminder once, so a job that runs twice in a day does not flood the client', () => {
    const now = at('2026-10-18T09:00:00.000Z')
    expect(reminderDue(deadline, now, 0)).not.toBeNull()
    expect(reminderDue(deadline, now, 1)).toBeNull()
  })

  it('does not skip ahead when a run is missed: the next unsent reminder goes out', () => {
    // Nothing ran for a fortnight and the deadline is now two days away. The client has had
    // no reminder at all, so they get one, rather than the schedule silently passing them by.
    const due = reminderDue(deadline, at('2026-10-30T09:00:00.000Z'), 0)
    expect(due).toMatchObject({ index: 0 })
  })

  it('stops once all three have gone out', () => {
    expect(reminderDue(deadline, at('2026-10-31T12:00:00.000Z'), 3)).toBeNull()
  })

  it('shows the operator a meeting no later than the last reminder to the client', () => {
    // If the operator first saw a meeting after its final chase, there would be nothing left
    // to chase. This is the invariant that keeps the two schedules in the right order.
    expect(OPERATOR_WARNING_DAYS).toBeGreaterThanOrEqual(
      Math.min(...REMINDER_DAYS_BEFORE_DEADLINE),
    )
  })
})

describe('the deadline in words', () => {
  it('names the UTC date, so nobody reads the deadline a day out', () => {
    expect(formatDeadline(at('2026-10-31T23:59:59.999Z'))).toBe('31 October 2026')
    expect(formatDeadline(at('2027-01-31T23:59:59.999Z'))).toBe('31 January 2027')
  })
})
