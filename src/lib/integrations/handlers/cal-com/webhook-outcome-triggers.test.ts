// The two post-meeting notifications, parsed.
//
// These are the triggers that could most easily be wired into money by mistake, so what each
// one is ALLOWED to mean is asserted here rather than left to the recorder:
//
//   MEETING_ENDED            the slot has passed. Nothing more. It fires at the scheduled end
//                            time whether or not anybody attended, so it can only ever mean
//                            "ask a person now".
//   BOOKING_NO_SHOW_UPDATED  a host marked an attendee absent, by hand. A human judgement,
//                            and one that can only ever record a no-show.
//
// The Cal Video no-show triggers are deliberately NOT handled: they need Cal's own video
// product and every client seat uses the client's own Meet, Teams or Zoom, so they would never
// fire for a client meeting (ADR-057).

import { describe, it, expect } from 'vitest'
import { parseCalComEvent } from './webhook'

const UID = 'bFJeNb2uX8ANpT3JL5EfXw'

describe('MEETING_ENDED means the slot has passed, and nothing else', () => {
  it('parses the flat payload into an ended event carrying the end time', () => {
    // MEETING_ENDED carries the booking's fields at the top level of payload, not nested.
    const parsed = parseCalComEvent({
      triggerEvent: 'MEETING_ENDED',
      payload: {
        uid: UID,
        title: 'Intro call',
        startTime: '2026-09-20T14:00:00.000Z',
        endTime: '2026-09-20T14:30:00.000Z',
        organizer: { email: 'doug@margenticos.com' },
      },
    })

    expect(parsed).toEqual({ kind: 'ended', bookingUid: UID, endTime: '2026-09-20T14:30:00.000Z' })
  })

  it('carries no attendance claim of any kind in its parsed shape', () => {
    // A structural assertion, on purpose. If somebody later adds a held or billable field to
    // this event, this fails and they have to come and read the comment above.
    const parsed = parseCalComEvent({
      triggerEvent: 'MEETING_ENDED',
      payload: { uid: UID, endTime: '2026-09-20T14:30:00.000Z' },
    })
    expect(Object.keys(parsed).sort()).toEqual(['bookingUid', 'endTime', 'kind'])
  })

  it('is malformed, not ignored, when it names no booking', () => {
    const parsed = parseCalComEvent({ triggerEvent: 'MEETING_ENDED', payload: { endTime: null } })
    expect(parsed).toMatchObject({ kind: 'malformed' })
  })
})

describe('BOOKING_NO_SHOW_UPDATED records a no-show, and only when one was marked', () => {
  it('reads the booking from bookingUid, which is where this trigger puts it', () => {
    const parsed = parseCalComEvent({
      triggerEvent: 'BOOKING_NO_SHOW_UPDATED',
      payload: {
        message: 'x marked as no-show',
        bookingUid: UID,
        bookingId: 4321,
        attendees: [{ email: 'Jordan.Reid@Northwind.test', noShow: true }],
      },
    })

    expect(parsed).toEqual({
      kind: 'no_show_marked',
      bookingUid: UID,
      attendeeEmail: 'jordan.reid@northwind.test', // lowercased, as everywhere else
    })
  })

  it('IGNORES an unmark, because that is the opposite of what it would otherwise record', () => {
    // The same trigger fires when a host removes a no-show mark. Reading noShow false as a
    // no-show would record the reverse of what the person just did.
    const parsed = parseCalComEvent({
      triggerEvent: 'BOOKING_NO_SHOW_UPDATED',
      payload: { bookingUid: UID, attendees: [{ email: 'jordan@northwind.test', noShow: false }] },
    })
    expect(parsed).toEqual({ kind: 'ignored', trigger: 'BOOKING_NO_SHOW_UPDATED' })
  })

  it('ignores a delivery with no attendees at all rather than guessing', () => {
    expect(parseCalComEvent({ triggerEvent: 'BOOKING_NO_SHOW_UPDATED', payload: { bookingUid: UID } }))
      .toEqual({ kind: 'ignored', trigger: 'BOOKING_NO_SHOW_UPDATED' })
    expect(parseCalComEvent({ triggerEvent: 'BOOKING_NO_SHOW_UPDATED', payload: { bookingUid: UID, attendees: [] } }))
      .toEqual({ kind: 'ignored', trigger: 'BOOKING_NO_SHOW_UPDATED' })
  })

  it('takes the marked attendee when several are listed', () => {
    const parsed = parseCalComEvent({
      triggerEvent: 'BOOKING_NO_SHOW_UPDATED',
      payload: {
        bookingUid: UID,
        attendees: [
          { email: 'present@northwind.test', noShow: false },
          { email: 'absent@northwind.test', noShow: true },
        ],
      },
    })
    expect(parsed).toMatchObject({ kind: 'no_show_marked', attendeeEmail: 'absent@northwind.test' })
  })
})

describe('the Cal Video no-show triggers stay unhandled on purpose', () => {
  it.each([
    'AFTER_HOSTS_CAL_VIDEO_NO_SHOW',
    'AFTER_GUESTS_CAL_VIDEO_NO_SHOW',
  ])('%s is ignored, because it can never fire for a client on their own video tool', (trigger) => {
    expect(parseCalComEvent({ triggerEvent: trigger, payload: { uid: UID } }))
      .toEqual({ kind: 'ignored', trigger })
  })

  it('still ignores anything else Cal.com may send', () => {
    expect(parseCalComEvent({ triggerEvent: 'FORM_SUBMITTED', payload: { uid: UID } }))
      .toEqual({ kind: 'ignored', trigger: 'FORM_SUBMITTED' })
  })
})

describe('a created booking now carries its scheduled end', () => {
  it('reads endTime alongside startTime, which is what makes "has it finished?" answerable', () => {
    const parsed = parseCalComEvent({
      triggerEvent: 'BOOKING_CREATED',
      payload: {
        uid: UID,
        startTime: '2026-09-20T14:00:00.000Z',
        endTime: '2026-09-20T14:30:00.000Z',
        organizer: { email: 'Doug@Margenticos.com' },
        attendees: [{ email: 'jordan@northwind.test', name: 'Jordan Reid' }],
        responses: {},
      },
    })

    expect(parsed).toMatchObject({
      kind: 'created',
      endTime: '2026-09-20T14:30:00.000Z',
      startTime: '2026-09-20T14:00:00.000Z',
      hostRef: 'doug@margenticos.com',
    })
  })
})
