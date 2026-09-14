// The two funnel measurements, and the four ways each could read healthy while it is not.
//
// EVERY TEST HERE IS ABOUT A NUMBER LOOKING BETTER THAN REALITY. Time to booking is a median
// over successes, so it can only flatter; linked-and-never-booked is the denominator that
// makes it honest. The cases below are the specific ways either half can quietly shrink.
//
// MUTATION-PROVED on commit, each turning a named test red:
//   dropping the actionSucceeded filter        -> a failed send appears in never-booked
//   dropping the no-prospect branch            -> a booking with no prospect vanishes
//   clamping a negative interval to zero       -> the fault disappears and the median moves

import { describe, it, expect } from 'vitest'
import {
  MINIMUM_AGE_HOURS,
  computeBookingFunnel,
  type Booking,
  type LinkSend,
} from '../booking-funnel'

const ORG = 'org-a'
const NOW = new Date('2026-09-14T18:00:00.000Z')

function send(prospectId: string | null, linkSentAt: string | null, succeeded: boolean | null = true): LinkSend {
  return { actionId: `action-${prospectId}-${linkSentAt}`, organisationId: ORG, prospectId, linkSentAt, actionSucceeded: succeeded }
}

function booking(meetingId: string, prospectId: string | null, bookedAt: string): Booking {
  return { meetingId, organisationId: ORG, prospectId, bookedAt }
}

function funnel(linkSends: LinkSend[], bookings: Booking[], unattributedBookings = 0) {
  return computeBookingFunnel({ linkSends, bookings, unattributedBookings }, NOW)
}

describe('time to booking', () => {
  it('measures each booking from its own link send, and reports the median with n', () => {
    const result = funnel(
      [
        send('p1', '2026-09-14T10:00:00.000Z'),
        send('p2', '2026-09-14T10:00:00.000Z'),
        send('p3', '2026-09-14T10:00:00.000Z'),
      ],
      [
        booking('m1', 'p1', '2026-09-14T10:30:00.000Z'), // 30 minutes
        booking('m2', 'p2', '2026-09-14T11:00:00.000Z'), // 60
        booking('m3', 'p3', '2026-09-14T13:00:00.000Z'), // 180
      ],
    )

    expect(result.timeToBooking.map(r => r.minutes).sort((a, b) => (a as number) - (b as number))).toEqual([30, 60, 180])
    expect(result.medianMinutes).toBe(60)
    expect(result.sampleSize).toBe(3)
  })

  it('has no median and a sample of zero when nobody has booked, rather than a flattering number', () => {
    const result = funnel([send('p1', '2026-09-10T10:00:00.000Z')], [])
    expect(result.medianMinutes).toBeNull()
    expect(result.sampleSize).toBe(0)
  })

  it('attributes a booking to the latest link sent BEFORE it, not the first one', () => {
    const result = funnel(
      [send('p1', '2026-09-14T09:00:00.000Z'), send('p1', '2026-09-14T11:00:00.000Z')],
      [booking('m1', 'p1', '2026-09-14T11:30:00.000Z')],
    )
    expect(result.timeToBooking[0].minutes).toBe(30)
  })
})

describe('a negative interval is a fault, never a fast booking', () => {
  it('records it as faulty with no minutes, and keeps it out of the median', () => {
    // THE SHAPE: clamping this to zero would pull the median DOWN, which is the direction
    // that flatters, and the disorder that produced it would never be seen.
    const result = funnel(
      [
        send('p1', '2026-09-14T10:00:00.000Z'),
        send('p2', '2026-09-14T14:00:00.000Z'), // sent AFTER p2 booked
      ],
      [
        booking('m1', 'p1', '2026-09-14T11:00:00.000Z'), // sound, 60 minutes
        booking('m2', 'p2', '2026-09-14T12:00:00.000Z'), // booked two hours before the link
      ],
    )

    const faultyRow = result.timeToBooking.find(r => r.prospectId === 'p2')
    expect(faultyRow).toMatchObject({ faulty: true, minutes: null })
    expect(result.faultyIntervals).toBe(1)

    // The median is the sound interval alone, not an average with a zero in it.
    expect(result.medianMinutes).toBe(60)
    expect(result.sampleSize).toBe(1)
  })

  it('still shows the faulty booking as a row, rather than dropping it', () => {
    const result = funnel(
      [send('p1', '2026-09-14T14:00:00.000Z')],
      [booking('m1', 'p1', '2026-09-14T12:00:00.000Z')],
    )
    expect(result.timeToBooking).toHaveLength(1)
    expect(result.timeToBooking[0].faulty).toBe(true)
  })
})

describe('a failed send is counted, and never sits in never-booked', () => {
  it('appears in failedSends and NOT in the never-booked list', () => {
    // THE SHAPE DOUG NAMED. "Was sent a link" has to mean the provider accepted it, which
    // silently drops the person who asked to book and got nothing. They are the most
    // expensive row on the screen, so they are counted on their own instead of being
    // quietly folded into a healthy-looking drop-off list.
    const result = funnel(
      [
        send('p-failed', null, false),                      // asked, send failed
        send('p-linked', '2026-09-10T10:00:00.000Z', true),  // asked, linked, never booked
      ],
      [],
    )

    expect(result.failedSends).toBe(1)
    expect(result.neverBooked.map(r => r.prospectId)).toEqual(['p-linked'])
    expect(result.neverBooked.map(r => r.prospectId)).not.toContain('p-failed')
  })

  it('counts a failure even when no timestamp was written at all', () => {
    // The row fails before the provider is called, so link_sent_at is null. Inferring the
    // failure from the absent timestamp would miss it; it comes from action_succeeded.
    expect(funnel([send('p1', null, false)], []).failedSends).toBe(1)
  })

  it('trusts action_succeeded over the timestamp, even when both disagree', () => {
    // THE CASE THAT MAKES THE succeeded CHECK LOAD-BEARING, and it is here deliberately.
    //
    // The test above uses a failed row with a null timestamp, so it would still pass if
    // somebody deleted the action_succeeded filter: the null timestamp excludes the row on
    // its own. That is a guard no test can distinguish from its neighbour, which is the
    // shape this suite keeps finding.
    //
    // A row that failed but carries a timestamp should not exist, because the send path
    // writes link_sent_at only on success. "Should not exist" is exactly the state to pin:
    // if it ever does, the answer must come from whether the send SUCCEEDED, not from
    // whether a timestamp happens to be present.
    const result = funnel([send('p-failed-with-stamp', '2026-09-10T10:00:00.000Z', false)], [])

    expect(result.failedSends).toBe(1)
    expect(result.neverBooked.map(r => r.prospectId)).not.toContain('p-failed-with-stamp')
    expect(result.neverBooked).toEqual([])
  })

  it('reports zero as a number, so the bucket cannot disappear from an empty screen', () => {
    const result = funnel([], [])
    expect(result.failedSends).toBe(0)
    expect(result.unattributedBookings).toBe(0)
  })
})

describe('a booking with no prospect does not vanish', () => {
  it('is counted rather than silently excluded from the sample', () => {
    // It cannot be joined to a link send, so it cannot carry an interval. Dropping it would
    // leave the prospect who booked looking like a drop-off with nothing to explain it.
    const result = funnel(
      [send('p1', '2026-09-14T10:00:00.000Z')],
      [booking('m1', 'p1', '2026-09-14T11:00:00.000Z'), booking('m2', null, '2026-09-14T12:00:00.000Z')],
    )

    expect(result.bookingsWithNoProspect).toBe(1)
    expect(result.timeToBooking).toHaveLength(1)
    expect(result.sampleSize).toBe(1)
  })

  it('carries the quarantined bookings count through, since it is the same story', () => {
    expect(funnel([], [], 3).unattributedBookings).toBe(3)
  })

  it('counts a booking from a prospect we never linked, and keeps it out of the median', () => {
    const result = funnel([], [booking('m1', 'p-never-linked', '2026-09-14T12:00:00.000Z')])
    expect(result.bookedWithoutLinkSend).toBe(1)
    expect(result.medianMinutes).toBeNull()
    expect(result.sampleSize).toBe(0)
  })
})

describe('never booked respects a minimum age, and says what it is', () => {
  it('excludes someone linked an hour ago, who is still deciding', () => {
    const result = funnel([send('p1', '2026-09-14T17:00:00.000Z')], [])
    expect(result.neverBooked).toEqual([])
    expect(result.minimumAgeHours).toBe(MINIMUM_AGE_HOURS)
  })

  it('includes someone linked well past the floor', () => {
    const result = funnel([send('p1', '2026-09-10T10:00:00.000Z')], [])
    expect(result.neverBooked).toHaveLength(1)
    expect(result.neverBooked[0].hoursSinceLink).toBe(104)
  })

  it('lists the oldest link first, because that is the one going cold', () => {
    const result = funnel(
      [
        send('p-recent', '2026-09-13T10:00:00.000Z'),
        send('p-oldest', '2026-09-08T10:00:00.000Z'),
        send('p-middle', '2026-09-11T10:00:00.000Z'),
      ],
      [],
    )
    expect(result.neverBooked.map(r => r.prospectId)).toEqual(['p-oldest', 'p-middle', 'p-recent'])
  })

  it('drops a prospect off the list as soon as they book', () => {
    const result = funnel(
      [send('p1', '2026-09-10T10:00:00.000Z')],
      [booking('m1', 'p1', '2026-09-11T10:00:00.000Z')],
    )
    expect(result.neverBooked).toEqual([])
  })

  it('keeps one client\'s prospect out of another client\'s numbers', () => {
    const result = computeBookingFunnel({
      linkSends: [{ actionId: 'a1', organisationId: 'org-a', prospectId: 'shared', linkSentAt: '2026-09-10T10:00:00.000Z', actionSucceeded: true }],
      // Same prospect id under a different organisation must not satisfy the link send above.
      bookings: [{ meetingId: 'm1', organisationId: 'org-b', prospectId: 'shared', bookedAt: '2026-09-11T10:00:00.000Z' }],
      unattributedBookings: 0,
    }, NOW)

    expect(result.neverBooked.map(r => r.prospectId)).toEqual(['shared'])
    expect(result.bookedWithoutLinkSend).toBe(1)
  })
})
