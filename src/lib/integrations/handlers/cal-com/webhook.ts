// src/lib/integrations/handlers/cal-com/webhook.ts
//
// The Cal.com half of booking detection: prove a notification came from Cal.com, and turn
// its payload into a vendor-neutral BookingEvent. Nothing here touches the database.
//
// SIGNATURE. Cal.com sends one header, x-cal-signature-256, carrying a hex HMAC-SHA256 of
// the RAW request body keyed with the secret we set on the webhook. It must be computed
// over the exact bytes received. Re-serialising parsed JSON changes whitespace and key
// order and fails for every genuine delivery, so the route reads the raw body before any
// parsing and hands it here unchanged.
//
// Reference: https://cal.com/docs/developing/guides/automation/webhooks (read 2026-09-11).

import crypto from 'crypto'
import type { BookingEvent } from '@/lib/meetings/booking-event'
import { PROSPECT_REF_PARAM } from '@/lib/meetings/booking-link'

/** Recorded on quarantined rows so a second booking tool's rows can be told apart. */
export const CAL_COM_PROVIDER = 'cal_com'

export const CAL_COM_SIGNATURE_HEADER = 'x-cal-signature-256'

/**
 * True only when the header is the hex HMAC-SHA256 of rawBody under secret. Never throws:
 * a missing, malformed or wrong-length header is simply false.
 */
export function verifyCalComSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header || !secret) return false
  const given = header.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(given)) return false
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  return crypto.timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'))
}

// The only three notifications that change a meeting. Everything else Cal.com can send is
// acknowledged and ignored.
//
// MEETING_ENDED IS DELIBERATELY ABSENT, and must never be added here. It fires at the
// scheduled end time whether or not anyone attended, so wiring it to held or billable would
// bill meetings nobody came to. Held stays an operator judgement (ADR-056).
const HANDLED_TRIGGERS: Record<string, 'created' | 'cancelled' | 'rescheduled'> = {
  BOOKING_CREATED: 'created',
  BOOKING_CANCELLED: 'cancelled',
  BOOKING_RESCHEDULED: 'rescheduled',
}

export type CalComParseResult =
  | BookingEvent
  | { kind: 'ignored'; trigger: string }
  | { kind: 'malformed'; reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

// A booking-question answer arrives as { label, value } in responses, and may be a bare
// string elsewhere. Both are accepted.
function readAnswer(value: unknown): string | null {
  if (isRecord(value)) return readString(value.value)
  return readString(value)
}

// Our reference can come back in three places depending on how the booking question is
// set up. It is only a hint: recordBookingEvent checks it belongs to the hosting client.
function readProspectRef(payload: Record<string, unknown>): string | null {
  const sources = [payload.responses, payload.userFieldsResponses, payload.metadata]
  for (const source of sources) {
    if (!isRecord(source)) continue
    const found = readAnswer(source[PROSPECT_REF_PARAM])
    if (found) return found
  }
  return null
}

export function parseCalComEvent(body: unknown): CalComParseResult {
  if (!isRecord(body)) return { kind: 'malformed', reason: 'body is not a JSON object' }

  const trigger = readString(body.triggerEvent)
  if (!trigger) return { kind: 'malformed', reason: 'no triggerEvent' }

  const handled = HANDLED_TRIGGERS[trigger]
  if (!handled) return { kind: 'ignored', trigger }

  const payload = body.payload
  if (!isRecord(payload)) return { kind: 'malformed', reason: `${trigger} has no payload` }

  const bookingUid = readString(payload.uid)
  if (!bookingUid) return { kind: 'malformed', reason: `${trigger} has no booking uid` }

  if (handled === 'cancelled') return { kind: 'cancelled', bookingUid }

  const organizer = isRecord(payload.organizer) ? payload.organizer : {}
  const firstAttendee = Array.isArray(payload.attendees) && isRecord(payload.attendees[0])
    ? payload.attendees[0]
    : {}
  const responses = isRecord(payload.responses) ? payload.responses : {}

  const hostEmail = readString(organizer.email)
  const attendeeEmail = readString(firstAttendee.email) ?? readAnswer(responses.email)

  const details = {
    bookingUid,
    startTime: readString(payload.startTime),
    hostRef: hostEmail ? hostEmail.toLowerCase() : null,
    attendeeEmail: attendeeEmail ? attendeeEmail.toLowerCase() : null,
    attendeeName: readString(firstAttendee.name) ?? readAnswer(responses.name),
    prospectRef: readProspectRef(payload),
  }

  if (handled === 'created') return { kind: 'created', ...details }
  return { kind: 'rescheduled', previousBookingUid: readString(payload.rescheduleUid), ...details }
}
