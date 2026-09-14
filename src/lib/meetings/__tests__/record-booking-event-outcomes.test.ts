// The two post-meeting events, recorded. Driven against the STRICT fake, which applies every
// filter and throws on any method it does not implement.
//
// WHAT THIS FILE IS PROTECTING. These are the only two paths by which a booking tool can
// touch a meeting AFTER it was supposed to happen, so they are the two most likely to be
// wired into money by accident:
//
//   ended           fires at the scheduled end time whether or not anyone attended. It may
//                   stamp "ask a person" and NOTHING else.
//   no_show_marked  a host's own judgement. It records a no-show, which is never billable,
//                   and it must never overturn an answer a person already gave.
//
// MUTATION-PROVED on commit: making 'ended' write meeting_status 'held' or is_billable true
// turns "stamps a timestamp and nothing else" red.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createStrictFakeDb, type StrictFakeDb } from './helpers/strict-fake-db'
import { recordBookingEvent } from '../record-booking-event'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/notifications/send-first-meeting-email', () => ({
  sendFirstMeetingEmail: vi.fn(async () => ({ sent: false })),
}))
vi.mock('@/lib/notifications/send-unmatched-booking-notification', () => ({
  sendUnmatchedBookingNotification: vi.fn(async () => ({ sent: false })),
}))

const PROVIDER = 'cal_com'
const UID = 'booking-uid-1'

function meeting(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm-1',
    organisation_id: 'org-a',
    prospect_id: 'prospect-1',
    booking_uid: UID,
    meeting_status: 'booked',
    held_decision_locked: false,
    held_confirmed_by: null,
    is_billable: false,
    billable_basis: null,
    scheduled_start_at: '2026-09-20T14:00:00.000Z',
    scheduled_end_at: null,
    outcome_requested_at: null,
    confirmation_sent_at: null,
    bill_unconfirmed_after: '2026-10-31T23:59:59.999Z',
    reminder_count: 0,
    ...overrides,
  }
}

let db: StrictFakeDb
function seed(rows: Record<string, unknown>[]) {
  db = createStrictFakeDb({ meetings: rows, unattributed_bookings: [], organisations: [], prospects: [] })
}

beforeEach(() => {
  vi.clearAllMocks()
  seed([meeting()])
})

describe('meeting ended: ask a person, claim nothing', () => {
  it('stamps that an outcome is wanted, and the end time, and nothing else', async () => {
    const result = await recordBookingEvent(
      db.client,
      { kind: 'ended', bookingUid: UID, endTime: '2026-09-20T14:30:00.000Z' },
      PROVIDER,
    )

    expect(result).toEqual({ outcome: 'outcome_requested', meetingId: 'm-1' })

    const row = db.tables.meetings[0]
    expect(row.outcome_requested_at).not.toBeNull()
    expect(row.scheduled_end_at).toBe('2026-09-20T14:30:00.000Z')

    // THE ASSERTION THIS FILE EXISTS FOR. A notification that fires on a clock must not
    // decide whether a meeting happened, and must not make it billable.
    expect(row).toMatchObject({
      meeting_status: 'booked',
      held_decision_locked: false,
      held_confirmed_by: null,
      is_billable: false,
      billable_basis: null,
    })
  })

  it('does not restart the asking when the same notification arrives again', async () => {
    await recordBookingEvent(db.client, { kind: 'ended', bookingUid: UID, endTime: null }, PROVIDER)
    const firstStamp = db.tables.meetings[0].outcome_requested_at

    const second = await recordBookingEvent(db.client, { kind: 'ended', bookingUid: UID, endTime: null }, PROVIDER)

    expect(second).toEqual({ outcome: 'no_change', detail: 'an outcome was already requested' })
    expect(db.tables.meetings[0].outcome_requested_at).toBe(firstStamp)
  })

  it('leaves a decided meeting alone and says why', async () => {
    seed([meeting({ meeting_status: 'held', held_decision_locked: true, held_confirmed_by: 'client', is_billable: true, billable_basis: 'client_confirmed' })])

    const result = await recordBookingEvent(db.client, { kind: 'ended', bookingUid: UID, endTime: null }, PROVIDER)

    expect(result).toMatchObject({ outcome: 'no_change' })
    expect(db.tables.meetings[0]).toMatchObject({
      meeting_status: 'held', billable_basis: 'client_confirmed', outcome_requested_at: null,
    })
  })

  it('reports a booking it has never seen rather than silently doing nothing', async () => {
    const result = await recordBookingEvent(db.client, { kind: 'ended', bookingUid: 'never-seen', endTime: null }, PROVIDER)
    expect(result).toEqual({ outcome: 'no_change', detail: 'no booking recorded under this uid' })
  })
})

describe('no-show marked by the host: an outcome, never revenue', () => {
  it('records the no-show, locks it, and leaves it unbillable with no basis', async () => {
    const result = await recordBookingEvent(
      db.client,
      { kind: 'no_show_marked', bookingUid: UID, attendeeEmail: 'sam@example.test' },
      PROVIDER,
    )

    expect(result).toEqual({ outcome: 'no_show_recorded', meetingId: 'm-1' })
    expect(db.tables.meetings[0]).toMatchObject({
      meeting_status: 'no_show',
      held_confirmed_by: 'host',
      held_decision_locked: true,
      is_billable: false,
      // No basis exists for "a host said nobody came", and the database would refuse a
      // billable row without one anyway.
      billable_basis: null,
    })
  })

  it('does NOT overturn an answer a person already gave', async () => {
    // A client confirmed the meeting happened. A later mark in the booking tool must not
    // quietly reverse that: it would change an outcome with nobody deciding it.
    seed([meeting({
      meeting_status: 'held',
      held_decision_locked: true,
      held_confirmed_by: 'client',
      is_billable: true,
      billable_basis: 'client_confirmed',
    })])

    const result = await recordBookingEvent(
      db.client,
      { kind: 'no_show_marked', bookingUid: UID, attendeeEmail: 'sam@example.test' },
      PROVIDER,
    )

    expect(result).toMatchObject({ outcome: 'no_change', detail: 'meeting is already held' })
    expect(db.tables.meetings[0]).toMatchObject({
      meeting_status: 'held', held_confirmed_by: 'client', is_billable: true, billable_basis: 'client_confirmed',
    })
  })

  it('reports a booking it has never seen', async () => {
    const result = await recordBookingEvent(
      db.client,
      { kind: 'no_show_marked', bookingUid: 'never-seen', attendeeEmail: null },
      PROVIDER,
    )
    expect(result).toEqual({ outcome: 'no_change', detail: 'no booking recorded under this uid' })
  })
})

describe('a booking is recorded with its deadline already on it', () => {
  it('stores the end time and the calendar deadline when the booking is taken', async () => {
    seed([])
    db.tables.organisations.push({ id: 'org-a', name: 'Apex Consulting', booking_host_ref: 'host@example.test', archived_at: null })
    db.tables.prospects.push({ id: 'prospect-1', organisation_id: 'org-a', email: 'sam@example.test' })

    await recordBookingEvent(db.client, {
      kind: 'created',
      bookingUid: 'new-uid',
      startTime: '2026-09-20T14:00:00.000Z',
      endTime: '2026-09-20T14:30:00.000Z',
      hostRef: 'host@example.test',
      attendeeEmail: 'sam@example.test',
      attendeeName: 'Sam Booker',
      prospectRef: null,
    }, PROVIDER)

    // A September meeting bills unconfirmed at the end of October. Stored at booking time, so
    // the reminders, the operator list and the backstop all read one value.
    expect(db.tables.meetings[0]).toMatchObject({
      scheduled_end_at: '2026-09-20T14:30:00.000Z',
      bill_unconfirmed_after: '2026-10-31T23:59:59.999Z',
      is_billable: false,
    })
    // The recorder does not write billable_basis AT ALL, which is stronger than writing null:
    // there is no code path from a new booking to a basis. Asserted as absent rather than as
    // null, because null was what the first version of this test wrongly expected.
    expect(db.tables.meetings[0].billable_basis).toBeUndefined()
  })
})
