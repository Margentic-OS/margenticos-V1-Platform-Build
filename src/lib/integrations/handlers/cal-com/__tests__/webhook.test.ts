// The Cal.com handler on its own: the signature check, and turning a payload into a
// vendor-neutral BookingEvent. The route test proves these are wired in; this file proves
// what they accept and refuse.

import { describe, it, expect } from 'vitest'
import crypto from 'crypto'
import { checkCalComSignature, parseCalComEvent, verifyCalComSignature } from '../webhook'

const SECRET = 'test-secret-not-a-real-key'
const sign = (body: string, secret = SECRET) =>
  crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex')

// Shaped on the BOOKING_CREATED example in Cal.com's webhook documentation, read 2026-09-11.
function bookingPayload(overrides: Record<string, unknown> = {}) {
  return {
    triggerEvent: 'BOOKING_CREATED',
    createdAt: '2026-09-11T09:30:00.538Z',
    payload: {
      startTime: '2026-09-15T09:30:00Z',
      endTime: '2026-09-15T10:00:00Z',
      organizer: { id: 5, name: 'Host Person', email: 'Host@Example.test', username: 'host' },
      responses: {
        name: { label: 'your_name', value: 'Sam Booker' },
        email: { label: 'email_address', value: 'sam@example.test' },
        prospect_ref: { label: 'prospect_ref', value: '11111111-2222-3333-4444-555555555555' },
      },
      userFieldsResponses: {},
      attendees: [{ email: 'Sam@Example.test', name: 'Sam Booker' }],
      uid: 'booking-uid-1',
      metadata: {},
      status: 'ACCEPTED',
      ...overrides,
    },
  }
}

describe('verifyCalComSignature', () => {
  const body = JSON.stringify(bookingPayload())

  it('accepts the hex HMAC-SHA256 of the raw body under our secret', () => {
    expect(verifyCalComSignature(body, sign(body), SECRET)).toBe(true)
  })

  it('accepts the same signature in upper case', () => {
    expect(verifyCalComSignature(body, sign(body).toUpperCase(), SECRET)).toBe(true)
  })

  it('refuses a signature made with a different secret', () => {
    expect(verifyCalComSignature(body, sign(body, 'someone-elses-secret'), SECRET)).toBe(false)
  })

  it('refuses a body changed after signing, even by whitespace', () => {
    expect(verifyCalComSignature(`${body} `, sign(body), SECRET)).toBe(false)
  })

  it('refuses a missing, empty, short or non-hex header without throwing', () => {
    expect(verifyCalComSignature(body, null, SECRET)).toBe(false)
    expect(verifyCalComSignature(body, '', SECRET)).toBe(false)
    expect(verifyCalComSignature(body, 'abc123', SECRET)).toBe(false)
    expect(verifyCalComSignature(body, 'no-secret-provided', SECRET)).toBe(false)
    expect(verifyCalComSignature(body, 'z'.repeat(64), SECRET)).toBe(false)
  })

  it('refuses everything when no secret is configured', () => {
    expect(verifyCalComSignature(body, sign(body, ''), '')).toBe(false)
  })
})

describe('parseCalComEvent', () => {
  it('reads a booking: uid, start, lowercased host and attendee, and our prospect reference', () => {
    expect(parseCalComEvent(bookingPayload())).toEqual({
      kind: 'created',
      bookingUid: 'booking-uid-1',
      startTime: '2026-09-15T09:30:00Z',
      hostRef: 'host@example.test',
      attendeeEmail: 'sam@example.test',
      attendeeName: 'Sam Booker',
      prospectRef: '11111111-2222-3333-4444-555555555555',
    })
  })

  it('finds the prospect reference in userFieldsResponses or metadata when responses lacks it', () => {
    const viaUserFields = parseCalComEvent(bookingPayload({
      responses: {},
      userFieldsResponses: { prospect_ref: { label: 'prospect_ref', value: 'ref-a' } },
    }))
    expect(viaUserFields).toMatchObject({ prospectRef: 'ref-a' })

    const viaMetadata = parseCalComEvent(bookingPayload({ responses: {}, metadata: { prospect_ref: 'ref-b' } }))
    expect(viaMetadata).toMatchObject({ prospectRef: 'ref-b' })
  })

  it('has no prospect reference, rather than an empty one, when none came back', () => {
    expect(parseCalComEvent(bookingPayload({ responses: {} }))).toMatchObject({ prospectRef: null })
  })

  it('reads a reschedule with the uid of the booking it replaces', () => {
    const body = { ...bookingPayload({ uid: 'booking-uid-2', rescheduleUid: 'booking-uid-1' }), triggerEvent: 'BOOKING_RESCHEDULED' }
    expect(parseCalComEvent(body)).toMatchObject({
      kind: 'rescheduled', bookingUid: 'booking-uid-2', previousBookingUid: 'booking-uid-1',
    })
  })

  it('reads a cancellation by uid', () => {
    const body = { ...bookingPayload(), triggerEvent: 'BOOKING_CANCELLED' }
    expect(parseCalComEvent(body)).toEqual({ kind: 'cancelled', bookingUid: 'booking-uid-1' })
  })

  it('IGNORES meeting-ended, which fires whether or not anyone attended', () => {
    // Flat payload, as Cal.com documents for MEETING_STARTED and MEETING_ENDED.
    expect(parseCalComEvent({ triggerEvent: 'MEETING_ENDED', uid: 'booking-uid-1' }))
      .toEqual({ kind: 'ignored', trigger: 'MEETING_ENDED' })
    expect(parseCalComEvent({ triggerEvent: 'MEETING_STARTED', uid: 'booking-uid-1' }))
      .toEqual({ kind: 'ignored', trigger: 'MEETING_STARTED' })
  })

  it('ignores every other trigger, including a no-show update and a test ping', () => {
    for (const trigger of ['BOOKING_NO_SHOW_UPDATED', 'BOOKING_REQUESTED', 'PING']) {
      expect(parseCalComEvent({ ...bookingPayload(), triggerEvent: trigger })).toEqual({ kind: 'ignored', trigger })
    }
  })

  it('calls a booking event with no uid malformed rather than inventing one', () => {
    expect(parseCalComEvent(bookingPayload({ uid: undefined }))).toMatchObject({ kind: 'malformed' })
    expect(parseCalComEvent('not an object')).toMatchObject({ kind: 'malformed' })
    expect(parseCalComEvent({ payload: {} })).toMatchObject({ kind: 'malformed' })
  })
})

describe('checkCalComSignature says which way a signature failed', () => {
  const body = JSON.stringify(bookingPayload())

  it('passes a correct signature', () => {
    expect(checkCalComSignature(body, sign(body), SECRET)).toEqual({ ok: true })
  })

  it('no header, or an empty one: signature_missing', () => {
    expect(checkCalComSignature(body, null, SECRET)).toEqual({ ok: false, reason: 'signature_missing' })
    expect(checkCalComSignature(body, '  ', SECRET)).toEqual({ ok: false, reason: 'signature_missing' })
  })

  it('not a 64-character hex HMAC, including Cal.com\'s "no-secret-provided": signature_malformed', () => {
    expect(checkCalComSignature(body, 'no-secret-provided', SECRET)).toEqual({ ok: false, reason: 'signature_malformed' })
    expect(checkCalComSignature(body, 'abc123', SECRET)).toEqual({ ok: false, reason: 'signature_malformed' })
  })

  it('well formed but made with another secret: signature_mismatch', () => {
    expect(checkCalComSignature(body, sign(body, 'someone-elses-secret'), SECRET)).toEqual({ ok: false, reason: 'signature_mismatch' })
  })

  it('an empty secret is a mismatch, never a pass', () => {
    expect(checkCalComSignature(body, sign(body, ''), '')).toEqual({ ok: false, reason: 'signature_mismatch' })
  })
})
