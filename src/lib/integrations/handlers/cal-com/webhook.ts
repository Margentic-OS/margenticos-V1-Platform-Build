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

export type SignatureRefusal = 'signature_missing' | 'signature_malformed' | 'signature_mismatch'

/**
 * Checks the signature and, when it fails, says WHICH way. Never throws.
 *
 *   signature_missing    no x-cal-signature-256 header at all
 *   signature_malformed  a header that is not a 64-character hex HMAC. Cal.com sends the literal
 *                        "no-secret-provided" when its own webhook has no secret set.
 *   signature_mismatch   a well-formed signature our secret does not reproduce: both sides have
 *                        a secret, and they differ.
 *
 * WHY THE REASON MATTERS. From outside, every one of these is "rejected". Nobody can read the
 * secret back out of Vercel or Cal.com to compare them, so the reason is the only way to tell
 * "Cal.com has no secret" from "the two secrets differ". The caller checks OUR secret is set
 * before calling this; an empty secret here is a mismatch, never a pass.
 */
export function checkCalComSignature(
  rawBody: string,
  header: string | null,
  secret: string,
): { ok: true } | { ok: false; reason: SignatureRefusal } {
  if (header === null || header.trim() === '') return { ok: false, reason: 'signature_missing' }
  const given = header.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(given)) return { ok: false, reason: 'signature_malformed' }
  if (!secret) return { ok: false, reason: 'signature_mismatch' }
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  return crypto.timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'))
    ? { ok: true }
    : { ok: false, reason: 'signature_mismatch' }
}

/** True only when the header is the hex HMAC-SHA256 of rawBody under secret. Never throws. */
export function verifyCalComSignature(rawBody: string, header: string | null, secret: string): boolean {
  return checkCalComSignature(rawBody, header, secret).ok
}

/**
 * What each signature refusal means, in words an operator can act on. It names the vendor,
 * so it lives here in the handler layer, not in the route (ADR-001).
 */
export const SIGNATURE_REFUSAL_EXPLANATION: Record<SignatureRefusal, string> = {
  signature_missing:
    'The delivery carried no signature. The Cal.com webhook most likely has no secret set.',
  signature_malformed:
    'The signature is not a valid one. Cal.com sends "no-secret-provided" when its webhook has no secret set.',
  signature_mismatch:
    'Both sides have a secret and they differ: the value in Vercel is not the value in the Cal.com webhook. Compare secret_length and secret_trimmed_length for a stray space or newline.',
}

// The five notifications that touch a meeting. Everything else Cal.com can send is
// acknowledged and ignored.
//
// MEETING_ENDED IS HANDLED, AND IT MEANS ONLY "ASK SOMEBODY NOW".
//
// It fires at the scheduled end time whether or not anyone attended, so it is never evidence
// that a meeting happened. Wiring it to held or billable would bill meetings nobody came to.
// It is handled here so the platform knows when to ASK the client for an outcome, which is
// the primary path (ADR-057); what it writes is a timestamp, nothing more. Held stays a human
// judgement (ADR-056).
//
// AFTER_HOSTS_CAL_VIDEO_NO_SHOW and AFTER_GUESTS_CAL_VIDEO_NO_SHOW are deliberately absent.
// They fire only for bookings using Cal's own video product, and every client seat uses the
// client's own Google Meet, Teams or Zoom, so they would never fire for a client meeting.
// BOOKING_NO_SHOW_UPDATED is the one that does: a host marking an attendee absent by hand.
const HANDLED_TRIGGERS: Record<string, 'created' | 'cancelled' | 'rescheduled' | 'ended' | 'no_show_marked'> = {
  BOOKING_CREATED: 'created',
  BOOKING_CANCELLED: 'cancelled',
  BOOKING_RESCHEDULED: 'rescheduled',
  MEETING_ENDED: 'ended',
  BOOKING_NO_SHOW_UPDATED: 'no_show_marked',
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

  // BOOKING_NO_SHOW_UPDATED names the booking 'bookingUid'. Every other trigger uses 'uid'.
  const bookingUid = readString(payload.uid) ?? readString(payload.bookingUid)
  if (!bookingUid) return { kind: 'malformed', reason: `${trigger} has no booking uid` }

  if (handled === 'cancelled') return { kind: 'cancelled', bookingUid }

  // MEETING_ENDED carries a FLAT payload: the booking's own fields, not a nested booking
  // object. All that is taken from it is the uid and the end time, because all it means is
  // that the slot has passed.
  if (handled === 'ended') {
    return { kind: 'ended', bookingUid, endTime: readString(payload.endTime) }
  }

  // BOOKING_NO_SHOW_UPDATED: { message, attendees: [{ email, noShow }], bookingUid, bookingId }.
  //
  // ONLY AN ATTENDEE ACTUALLY MARKED ABSENT IS AN OUTCOME. The same trigger fires when a host
  // UNMARKS someone, with noShow false, and reading that as a no-show would record the
  // opposite of what the person just said. An unmark is ignored rather than reversed: the
  // decision is already locked by then, and reopening it from a webhook would let a booking
  // tool overturn a human judgement.
  if (handled === 'no_show_marked') {
    const attendees = Array.isArray(payload.attendees) ? payload.attendees : []
    const marked = attendees.find(entry => isRecord(entry) && entry.noShow === true)
    if (!isRecord(marked)) return { kind: 'ignored', trigger }
    const email = readString(marked.email)
    return { kind: 'no_show_marked', bookingUid, attendeeEmail: email ? email.toLowerCase() : null }
  }

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
    endTime: readString(payload.endTime),
    hostRef: hostEmail ? hostEmail.toLowerCase() : null,
    attendeeEmail: attendeeEmail ? attendeeEmail.toLowerCase() : null,
    attendeeName: readString(firstAttendee.name) ?? readAnswer(responses.name),
    prospectRef: readProspectRef(payload),
  }

  if (handled === 'created') return { kind: 'created', ...details }
  return { kind: 'rescheduled', previousBookingUid: readString(payload.rescheduleUid), ...details }
}
