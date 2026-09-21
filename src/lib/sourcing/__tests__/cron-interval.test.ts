// The cron minute parser, including every shape it must REFUSE.
//
// The refusals matter as much as the parses. This parser feeds two things: a timeout the
// verification sweep sizes itself against, and a time rendered on an operator screen. A
// parser that returned a confident answer for `19 3 * * *` would hand the sweep a period of
// one day and print a next-run time that is wrong by hours. Null is the answer that both
// callers already handle.

import { describe, it, expect } from 'vitest'
import { parseMinuteInterval, nextRunAfter } from '../cron-interval'

describe('parseMinuteInterval — the shapes this project schedules with', () => {
  it('reads every minute', () => {
    expect(parseMinuteInterval('* * * * *')).toEqual({ stepMinutes: 1, offsetMinutes: 0 })
  })

  it('reads a bare step', () => {
    expect(parseMinuteInterval('*/10 * * * *')).toEqual({ stepMinutes: 10, offsetMinutes: 0 })
    expect(parseMinuteInterval('*/5 * * * *')).toEqual({ stepMinutes: 5, offsetMinutes: 0 })
  })

  // THE LIVE SHAPE. verify-pending reads `4-59/10` in both cron.job and
  // cron_schedule_registry, measured 2026-09-21. A parser that only understood `*/10` would
  // return null for the one job this was written for.
  it('reads the staggered form the 2026-09-10 migration introduced', () => {
    expect(parseMinuteInterval('4-59/10 * * * *')).toEqual({ stepMinutes: 10, offsetMinutes: 4 })
    expect(parseMinuteInterval('7-59/10 * * * *')).toEqual({ stepMinutes: 10, offsetMinutes: 7 })
    expect(parseMinuteInterval('15-59/30 * * * *')).toEqual({ stepMinutes: 30, offsetMinutes: 15 })
    expect(parseMinuteInterval('1-59/5 * * * *')).toEqual({ stepMinutes: 5, offsetMinutes: 1 })
  })

  it('reads a single minute as hourly', () => {
    expect(parseMinuteInterval('30 * * * *')).toEqual({ stepMinutes: 60, offsetMinutes: 30 })
  })
})

describe('parseMinuteInterval — what it refuses', () => {
  // The daily jobs in cron_schedule_registry. Returning 24 hours here would be read by the
  // sweep as "you have a day", against a request capped at 300 seconds.
  it('refuses a schedule that pins an hour', () => {
    expect(parseMinuteInterval('19 3 * * *')).toBeNull()
    expect(parseMinuteInterval('9 9 * * *')).toBeNull()
  })

  it('refuses a schedule that pins a day, a month or a weekday', () => {
    expect(parseMinuteInterval('*/10 * 1 * *')).toBeNull()
    expect(parseMinuteInterval('*/10 * * 6 *')).toBeNull()
    expect(parseMinuteInterval('*/10 * * * MON')).toBeNull()
  })

  it('refuses a malformed or wrong-length schedule', () => {
    expect(parseMinuteInterval('')).toBeNull()
    expect(parseMinuteInterval('*/10')).toBeNull()
    expect(parseMinuteInterval('* * * * * *')).toBeNull()
    expect(parseMinuteInterval('banana * * * *')).toBeNull()
  })

  it('refuses a step of zero rather than dividing by it downstream', () => {
    expect(parseMinuteInterval('*/0 * * * *')).toBeNull()
    expect(parseMinuteInterval('0-59/0 * * * *')).toBeNull()
  })

  // A partial range fires only across part of the hour, which the modulo test used by
  // nextRunAfter cannot express. Admitting it would produce times the job never fires at.
  it('refuses a partial range, because the modulo test would report minutes it never fires at', () => {
    expect(parseMinuteInterval('4-30/10 * * * *')).toBeNull()
  })

  // `14-59/10` fires 14, 24, ... but `minute % 10 === 4` also admits minute 4, which is
  // outside the declared range. The parser rejects the form rather than silently widening it.
  it('refuses an offset the modulo test would not reproduce exactly', () => {
    expect(parseMinuteInterval('14-59/10 * * * *')).toBeNull()
  })

  it('refuses an out-of-range minute', () => {
    expect(parseMinuteInterval('60 * * * *')).toBeNull()
    expect(parseMinuteInterval('99-59/10 * * * *')).toBeNull()
  })
})

describe('nextRunAfter', () => {
  /** A fixed moment, so nothing here depends on when the suite runs. */
  const at = (iso: string) => new Date(iso)

  it('gives the next firing of the live verify-pending schedule', () => {
    // 4-59/10 fires at :04, :14, :24, :34, :44, :54.
    expect(nextRunAfter('4-59/10 * * * *', at('2026-09-21T12:00:00Z'))?.toISOString())
      .toBe('2026-09-21T12:04:00.000Z')
    expect(nextRunAfter('4-59/10 * * * *', at('2026-09-21T12:05:30Z'))?.toISOString())
      .toBe('2026-09-21T12:14:00.000Z')
  })

  // STRICTLY AFTER. Standing exactly on a firing minute, the answer is the NEXT one: the
  // current firing is either already running or already missed, and neither is in the future.
  it('is strictly after, so standing on a firing minute gives the following one', () => {
    expect(nextRunAfter('4-59/10 * * * *', at('2026-09-21T12:04:00Z'))?.toISOString())
      .toBe('2026-09-21T12:14:00.000Z')
  })

  it('rolls over the hour', () => {
    expect(nextRunAfter('4-59/10 * * * *', at('2026-09-21T12:56:00Z'))?.toISOString())
      .toBe('2026-09-21T13:04:00.000Z')
  })

  it('rolls over midnight', () => {
    expect(nextRunAfter('*/10 * * * *', at('2026-09-21T23:55:00Z'))?.toISOString())
      .toBe('2026-09-22T00:00:00.000Z')
  })

  it('discards seconds rather than rounding, because pg_cron fires on the minute', () => {
    expect(nextRunAfter('*/10 * * * *', at('2026-09-21T12:09:59.999Z'))?.toISOString())
      .toBe('2026-09-21T12:10:00.000Z')
  })

  it('handles the hourly form', () => {
    expect(nextRunAfter('30 * * * *', at('2026-09-21T12:31:00Z'))?.toISOString())
      .toBe('2026-09-21T13:30:00.000Z')
  })

  it('returns null for anything it cannot read, rather than a guessed time', () => {
    expect(nextRunAfter('19 3 * * *', at('2026-09-21T12:00:00Z'))).toBeNull()
    expect(nextRunAfter('nonsense', at('2026-09-21T12:00:00Z'))).toBeNull()
  })

  it('returns null for an invalid clock rather than an Invalid Date', () => {
    expect(nextRunAfter('*/10 * * * *', new Date(NaN))).toBeNull()
  })

  // Every minute a `*/N` schedule fires must be reproduced, for a whole hour, with no extras.
  // A modulo test that was off by one would show up here and nowhere else.
  it('reproduces exactly the minutes the staggered schedule fires at, across a full hour', () => {
    const fired: number[] = []
    let cursor = at('2026-09-21T12:00:00Z')
    for (let i = 0; i < 6; i++) {
      const next = nextRunAfter('4-59/10 * * * *', cursor)
      expect(next).not.toBeNull()
      cursor = next as Date
      fired.push(cursor.getUTCMinutes())
    }
    expect(fired).toEqual([4, 14, 24, 34, 44, 54])
  })
})
