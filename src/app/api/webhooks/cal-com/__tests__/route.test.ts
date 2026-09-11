// POST /api/webhooks/cal-com, driven with signed requests against a STRICT fake database.
//
// The Calendly route this replaces had tests that passed while it was broken: they signed in
// the same wrong format the code expected, and most of them asserted on literals the test
// itself had just written. Every test here goes through the real route, the real signature
// check, the real parser and the real recorder; only the database and the two outbound
// emails are stood in for. The fake throws on any query shape it does not implement and
// enforces the real unique keys, so a missing filter or a missing duplicate guard changes
// what the rows hold.
//
// MUTATION-PROVED on commit, each of these turning a named test red:
//   - the signature check removed from the route
//   - the signature computed over re-serialised JSON instead of the raw bytes
//   - an unmatched booking returned early instead of recorded
//   - the repeated-delivery (23505) handling removed
//   - meeting-ended mapped to a handled event

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import crypto from 'crypto'
import type { NextRequest } from 'next/server'
import { createStrictFakeDb, type StrictFakeDb } from '@/lib/meetings/__tests__/helpers/strict-fake-db'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }))

const createServiceRoleClient = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/service-role', () => ({ createServiceRoleClient }))

const sendFirstMeetingEmail = vi.hoisted(() => vi.fn(async () => ({ sent: true })))
vi.mock('@/lib/notifications/send-first-meeting-email', () => ({ sendFirstMeetingEmail }))

const sendUnmatchedBookingNotification = vi.hoisted(() => vi.fn(async () => ({ sent: true })))
vi.mock('@/lib/notifications/send-unmatched-booking-notification', () => ({ sendUnmatchedBookingNotification }))

import { POST } from '../route'

const SECRET = 'test-webhook-secret-not-a-real-one'
const HOST = 'host@example.test'
const PROSPECT_A = '11111111-2222-3333-4444-555555555555'
const PROSPECT_OTHER_CLIENT = '99999999-8888-7777-6666-555555555555'

const sign = (body: string, secret = SECRET) =>
  crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex')

function request(body: string, signature: string | null): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (signature !== null) headers['x-cal-signature-256'] = signature
  return new Request('http://localhost/api/webhooks/cal-com', { method: 'POST', body, headers }) as unknown as NextRequest
}

function booking(trigger: string, payload: Record<string, unknown> = {}) {
  return JSON.stringify({
    triggerEvent: trigger,
    createdAt: '2026-09-11T09:00:00Z',
    payload: {
      uid: 'uid-1',
      startTime: '2026-09-15T09:30:00Z',
      organizer: { email: HOST },
      attendees: [{ email: 'sam@example.test', name: 'Sam Booker' }],
      responses: { prospect_ref: { label: 'prospect_ref', value: PROSPECT_A } },
      ...payload,
    },
  })
}

let db: StrictFakeDb

function seed(extra: { meetings?: Record<string, unknown>[] } = {}, opts: { failInsertsInto?: string } = {}) {
  db = createStrictFakeDb({
    organisations: [
      { id: 'org-a', name: 'Client A', booking_host_ref: HOST, archived_at: null },
      { id: 'org-b', name: 'Client B', booking_host_ref: 'other-host@example.test', archived_at: null },
    ],
    prospects: [
      { id: PROSPECT_A, organisation_id: 'org-a', email: 'Sam@Example.test' },
      { id: PROSPECT_OTHER_CLIENT, organisation_id: 'org-b', email: 'someone@example.test' },
    ],
    meetings: extra.meetings ?? [],
    unattributed_bookings: [],
  }, opts)
  createServiceRoleClient.mockResolvedValue(db.client)
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CALCOM_WEBHOOK_SECRET = SECRET
  seed()
})

afterEach(() => {
  delete process.env.CALCOM_WEBHOOK_SECRET
})

describe('authentication is the signature', () => {
  it('REJECTS a wrongly signed delivery, and reads or writes nothing', async () => {
    const body = booking('BOOKING_CREATED')
    const res = await POST(request(body, sign(body, 'not-our-secret')))

    expect(res.status).toBe(401)
    expect(db.calls).toEqual([])
    expect(db.tables.meetings).toHaveLength(0)
    expect(createServiceRoleClient).not.toHaveBeenCalled()
  })

  it('REJECTS an unsigned delivery', async () => {
    const res = await POST(request(booking('BOOKING_CREATED'), null))
    expect(res.status).toBe(401)
    expect(db.calls).toEqual([])
  })

  it('refuses every delivery when the secret is not configured', async () => {
    delete process.env.CALCOM_WEBHOOK_SECRET
    const body = booking('BOOKING_CREATED')
    const res = await POST(request(body, sign(body)))
    expect(res.status).toBe(500)
    expect(db.calls).toEqual([])
  })

  it('verifies the RAW bytes: an oddly spaced body, signed exactly as sent, is accepted', async () => {
    // Re-serialising the parsed JSON would change these bytes and fail every real delivery.
    const body = `{\n  "triggerEvent" : "BOOKING_CREATED",\n  "payload" : ${JSON.stringify(JSON.parse(booking('BOOKING_CREATED')).payload, null, 4)}\n}\n`
    const res = await POST(request(body, sign(body)))
    expect(res.status).toBe(200)
    expect(db.tables.meetings).toHaveLength(1)
  })
})

describe('a booking is tied to its prospect, or recorded anyway', () => {
  it('ties a booking to its prospect by the reference carried on the link', async () => {
    const body = booking('BOOKING_CREATED')
    const res = await POST(request(body, sign(body)))

    expect(res.status).toBe(200)
    expect(db.tables.meetings).toHaveLength(1)
    expect(db.tables.meetings[0]).toMatchObject({
      organisation_id: 'org-a',
      prospect_id: PROSPECT_A,
      prospect_match: 'link',
      source: 'webhook',
      booking_uid: 'uid-1',
      meeting_status: 'booked',
      is_billable: false,
      held_decision_locked: false,
    })
    expect(sendFirstMeetingEmail).toHaveBeenCalledTimes(1)
    expect(sendUnmatchedBookingNotification).not.toHaveBeenCalled()
  })

  it('falls back to a case-insensitive email match when no reference came back', async () => {
    const body = booking('BOOKING_CREATED', {
      responses: {},
      attendees: [{ email: 'SAM@example.TEST', name: 'Sam Booker' }],
    })
    await POST(request(body, sign(body)))

    expect(db.tables.meetings[0]).toMatchObject({ prospect_id: PROSPECT_A, prospect_match: 'email' })
  })

  it('RECORDS an unmatched booking rather than discarding it, and tells the operator', async () => {
    const body = booking('BOOKING_CREATED', {
      responses: {},
      attendees: [{ email: 'stranger@example.test', name: 'A Stranger' }],
    })
    const res = await POST(request(body, sign(body)))

    expect(res.status).toBe(200)
    expect(db.tables.meetings).toHaveLength(1)
    expect(db.tables.meetings[0]).toMatchObject({
      organisation_id: 'org-a',
      prospect_id: null,
      prospect_match: 'none',
      attendee_email: 'stranger@example.test',
      attendee_name: 'A Stranger',
      is_billable: false,
    })
    expect(sendUnmatchedBookingNotification).toHaveBeenCalledWith(expect.objectContaining({ reason: 'no_prospect' }))
    expect(sendFirstMeetingEmail).not.toHaveBeenCalled()
  })

  it('never follows a prospect reference into another client', async () => {
    const body = booking('BOOKING_CREATED', {
      responses: { prospect_ref: { label: 'prospect_ref', value: PROSPECT_OTHER_CLIENT } },
      attendees: [{ email: 'stranger@example.test', name: 'A Stranger' }],
    })
    await POST(request(body, sign(body)))

    expect(db.tables.meetings[0]).toMatchObject({ organisation_id: 'org-a', prospect_id: null, prospect_match: 'none' })
  })

  it('quarantines a booking on a calendar that belongs to no client, rather than losing it', async () => {
    const body = booking('BOOKING_CREATED', { organizer: { email: 'unknown-seat@example.test' } })
    const res = await POST(request(body, sign(body)))

    expect(res.status).toBe(200)
    expect(db.tables.meetings).toHaveLength(0)
    expect(db.tables.unattributed_bookings).toHaveLength(1)
    expect(db.tables.unattributed_bookings[0]).toMatchObject({
      provider: 'cal_com',
      provider_booking_uid: 'uid-1',
      host_ref: 'unknown-seat@example.test',
    })
    expect(sendUnmatchedBookingNotification).toHaveBeenCalledWith(expect.objectContaining({ reason: 'unknown_host' }))
  })
})

describe('the same delivery twice', () => {
  it('makes ONE meeting and sends ONE email', async () => {
    const body = booking('BOOKING_CREATED')
    const first = await POST(request(body, sign(body)))
    const second = await POST(request(body, sign(body)))

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ outcome: 'duplicate' })
    expect(db.tables.meetings).toHaveLength(1)
    expect(sendFirstMeetingEmail).toHaveBeenCalledTimes(1)
  })

  it('quarantines ONE row for a repeated delivery from an unknown calendar', async () => {
    const body = booking('BOOKING_CREATED', { organizer: { email: 'unknown-seat@example.test' } })
    await POST(request(body, sign(body)))
    await POST(request(body, sign(body)))

    expect(db.tables.unattributed_bookings).toHaveLength(1)
    expect(sendUnmatchedBookingNotification).toHaveBeenCalledTimes(1)
  })
})

describe('cancelled and rescheduled are distinct events', () => {
  const bookedMeeting = {
    id: 'meeting-1', organisation_id: 'org-a', prospect_id: PROSPECT_A, booking_uid: 'uid-1',
    meeting_status: 'booked', is_billable: false, held_decision_locked: false,
    scheduled_start_at: '2026-09-15T09:30:00Z',
  }

  it('a cancellation cancels the booked meeting and keeps it off billing', async () => {
    seed({ meetings: [{ ...bookedMeeting }] })
    const body = booking('BOOKING_CANCELLED')
    const res = await POST(request(body, sign(body)))

    expect(res.status).toBe(200)
    expect(db.tables.meetings[0]).toMatchObject({ meeting_status: 'canceled', is_billable: false })
  })

  it('a cancellation never overturns a decision a person already made', async () => {
    seed({ meetings: [{ ...bookedMeeting, meeting_status: 'held', held_decision_locked: true, is_billable: true }] })
    const body = booking('BOOKING_CANCELLED')
    await POST(request(body, sign(body)))

    expect(db.tables.meetings[0]).toMatchObject({ meeting_status: 'held', is_billable: true })
  })

  it('a reschedule moves the meeting onto the new booking, without making a second one', async () => {
    seed({ meetings: [{ ...bookedMeeting }] })
    const body = booking('BOOKING_RESCHEDULED', {
      uid: 'uid-2', rescheduleUid: 'uid-1', startTime: '2026-09-18T14:00:00Z',
    })
    const first = await POST(request(body, sign(body)))
    const repeat = await POST(request(body, sign(body)))

    expect(first.status).toBe(200)
    expect(repeat.status).toBe(200)
    expect(db.tables.meetings).toHaveLength(1)
    expect(db.tables.meetings[0]).toMatchObject({
      booking_uid: 'uid-2', scheduled_start_at: '2026-09-18T14:00:00Z', meeting_status: 'booked',
    })
  })
})

describe('meeting-ended is not evidence that anyone attended', () => {
  it('is acknowledged and ignored: nothing is read or written, nothing becomes held or billable', async () => {
    seed({ meetings: [{
      id: 'meeting-1', organisation_id: 'org-a', prospect_id: PROSPECT_A, booking_uid: 'uid-1',
      meeting_status: 'booked', is_billable: false, held_decision_locked: false,
    }] })
    // Flat payload, as Cal.com documents for MEETING_ENDED.
    const body = JSON.stringify({ triggerEvent: 'MEETING_ENDED', uid: 'uid-1', createdAt: '2026-09-15T10:00:00Z' })
    const res = await POST(request(body, sign(body)))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ignored: 'MEETING_ENDED' })
    expect(db.calls).toEqual([])
    expect(db.tables.meetings[0]).toMatchObject({ meeting_status: 'booked', is_billable: false })
  })
})

describe('a failure is never reported as success', () => {
  it('answers 500 when the meeting cannot be written, so the provider can retry', async () => {
    seed({}, { failInsertsInto: 'meetings' })
    const body = booking('BOOKING_CREATED')
    const res = await POST(request(body, sign(body)))

    expect(res.status).toBe(500)
    expect(db.tables.meetings).toHaveLength(0)
  })
})
