// src/lib/meetings/record-booking-event.ts
//
// Turns a vendor-neutral BookingEvent into a meetings row. Called only from a booking-tool
// webhook route, and only AFTER that route has verified the provider's signature. The
// signature is the authentication, so this runs on the service-role client and applies its
// own organisation scoping explicitly on every query (ADR-003).
//
// ═════════════════════════════════════════════════════════════════════════════
// THREE RULES THAT SHAPE EVERYTHING BELOW
//
// 1. NEVER RETURN SUCCESS AND DISCARD. The Calendly route this replaces dropped any booking
//    it could not tie to a prospect and still answered 200. Here a booking with no matching
//    prospect is still a meetings row (prospect_match 'none'), and a booking hosted by a seat
//    that belongs to no client is a row in unattributed_bookings. The operator is emailed
//    about both. A database failure THROWS, so the route answers 500 and the provider can
//    try again.
//
// 2. A REPEATED DELIVERY IS A NO-OP. meetings.booking_uid, and unattributed_bookings on
//    (provider, provider_booking_uid), are UNIQUE in the database. A second insert of the
//    same booking fails with 23505, which is read as "already recorded": no second row, no
//    second email, and a success answer so the provider stops retrying.
//
// 3. A PROSPECT REFERENCE IS A HINT, NEVER AN AUTHORITY. It arrives on a URL anyone can
//    edit. It is accepted only for a prospect that belongs to the organisation owning the
//    hosting seat, so a reference to another client's prospect can never attach a meeting
//    across clients.
//
// An unmatched meeting (prospect_match 'none', prospect_id NULL) can never be billed: the
// database refuses it outright, through meetings_billable_needs_a_prospect (migration
// 20260912154500). That used to be a filter in the 72-hour auto-held job, which is gone.
//
// ═════════════════════════════════════════════════════════════════════════════
// 4. A BOOKING TOOL NEVER MAKES A MEETING BILLABLE. Two of the five events it sends arrive
//    after the meeting: 'ended', which fires at the scheduled end time whether or not anyone
//    attended, and 'no_show_marked', which is a host's own judgement. The first only stamps
//    "time to ask a person"; the second records a no-show, which is never billable. Nothing
//    in this file sets is_billable true, and nothing sets billable_basis. Billing needs a
//    human answer through the confirm route, or the monthly backstop (ADR-057).

import type { ServiceRoleClient } from '@/lib/supabase/service-role'
import { logger } from '@/lib/logger'
import { unconfirmedBillingDeadline } from './billing-deadline'
import type { BookedDetails, BookingEvent } from './booking-event'
import { sendFirstMeetingEmail } from '@/lib/notifications/send-first-meeting-email'
import { sendUnmatchedBookingNotification } from '@/lib/notifications/send-unmatched-booking-notification'

const UNIQUE_VIOLATION = '23505'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ProspectMatch = 'link' | 'email' | 'none'

export type BookingOutcome =
  | { outcome: 'recorded'; meetingId: string; prospectMatch: ProspectMatch }
  | { outcome: 'duplicate' }
  | { outcome: 'quarantined' }
  | { outcome: 'cancelled'; meetingId: string }
  | { outcome: 'rescheduled'; meetingId: string }
  /** The slot has passed and a person is now being asked. Nothing about held or billable. */
  | { outcome: 'outcome_requested'; meetingId: string }
  /** A host marked the attendee absent. Not billable, by definition. */
  | { outcome: 'no_show_recorded'; meetingId: string }
  | { outcome: 'no_change'; detail: string }

export async function recordBookingEvent(
  supabase: ServiceRoleClient,
  event: BookingEvent,
  provider: string,
): Promise<BookingOutcome> {
  switch (event.kind) {
    case 'created':
      return recordCreated(supabase, event, provider)
    case 'cancelled':
      return recordCancelled(supabase, event.bookingUid, provider)
    case 'rescheduled':
      return recordRescheduled(supabase, event, provider)
    case 'ended':
      return recordEnded(supabase, event.bookingUid, event.endTime)
    case 'no_show_marked':
      return recordNoShowMarked(supabase, event.bookingUid)
  }
}

/**
 * When this meeting bills if nobody ever answers: the last instant of the month AFTER the
 * month it happened in (2026-08-24 decision, computed in billing-deadline.ts).
 *
 * Falls back to the time the booking was taken when the tool reported no start time, because
 * a meeting with no deadline could never be billed and would sit unresolved for ever. The
 * fallback is the conservative direction only by accident, so it is stated rather than
 * relied on: a booking with no start time is a malformed booking and shows on the operator
 * screen as one.
 */
function billingDeadlineFor(startTime: string | null, bookedAt: string): string {
  const basis = startTime ? new Date(startTime) : new Date(bookedAt)
  const usable = Number.isNaN(basis.getTime()) ? new Date(bookedAt) : basis
  return unconfirmedBillingDeadline(usable).toISOString()
}

// ── Which client, which prospect ─────────────────────────────────────────────

async function resolveOrganisation(
  supabase: ServiceRoleClient,
  hostRef: string | null,
): Promise<{ id: string; name: string } | null> {
  if (!hostRef) return null
  const { data, error } = await supabase
    .from('organisations')
    .select('id, name')
    .eq('booking_host_ref', hostRef)
    .is('archived_at', null)
    .maybeSingle()
  if (error) throw new Error(`booking: organisation lookup failed: ${error.message}`)
  return data
}

// LIKE treats % and _ as wildcards, and an email address may contain _. Escaping keeps the
// database prefilter from widening; the exact comparison below is what decides a match.
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, char => `\\${char}`)
}

async function matchProspect(
  supabase: ServiceRoleClient,
  organisationId: string,
  details: BookedDetails,
): Promise<{ prospectId: string | null; match: ProspectMatch }> {
  const ref = details.prospectRef
  if (ref && UUID_PATTERN.test(ref)) {
    const { data, error } = await supabase
      .from('prospects')
      .select('id')
      .eq('id', ref)
      .eq('organisation_id', organisationId)
      .maybeSingle()
    if (error) throw new Error(`booking: prospect reference lookup failed: ${error.message}`)
    if (data) return { prospectId: data.id, match: 'link' }
    // Not this client's prospect, or no longer exists. Never followed across clients.
    logger.warn('booking: prospect reference is not a prospect of the hosting client, falling back to email', {
      organisation_id: organisationId,
      booking_uid: details.bookingUid,
    })
  }

  const email = details.attendeeEmail?.trim().toLowerCase()
  if (email) {
    const { data, error } = await supabase
      .from('prospects')
      .select('id, email')
      .eq('organisation_id', organisationId)
      .ilike('email', escapeLikePattern(email))
      .limit(10)
    if (error) throw new Error(`booking: prospect email lookup failed: ${error.message}`)
    const exact = (data ?? []).filter(row => (row.email ?? '').trim().toLowerCase() === email)
    if (exact.length === 1) return { prospectId: exact[0].id, match: 'email' }
    if (exact.length > 1) {
      logger.warn('booking: attendee email matches more than one prospect, not guessing', {
        organisation_id: organisationId,
        booking_uid: details.bookingUid,
        matches: exact.length,
      })
    }
  }

  return { prospectId: null, match: 'none' }
}

// ── Created ──────────────────────────────────────────────────────────────────

async function recordCreated(
  supabase: ServiceRoleClient,
  details: BookedDetails,
  provider: string,
): Promise<BookingOutcome> {
  const organisation = await resolveOrganisation(supabase, details.hostRef)
  if (!organisation) return quarantine(supabase, details, provider)

  const { prospectId, match } = await matchProspect(supabase, organisation.id, details)
  const bookedAt = new Date().toISOString()

  const { data, error } = await supabase
    .from('meetings')
    .insert({
      organisation_id: organisation.id,
      prospect_id: prospectId,
      source: 'webhook',
      booking_uid: details.bookingUid,
      booked_at: bookedAt,
      scheduled_start_at: details.startTime,
      scheduled_end_at: details.endTime,
      bill_unconfirmed_after: billingDeadlineFor(details.startTime, bookedAt),
      meeting_status: 'booked',
      is_billable: false,
      held_decision_locked: false,
      prospect_match: match,
      attendee_email: details.attendeeEmail,
      attendee_name: details.attendeeName,
    })
    .select('id')
    .single()

  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      logger.info('booking: already recorded, repeated delivery ignored', { booking_uid: details.bookingUid })
      return { outcome: 'duplicate' }
    }
    throw new Error(`booking: meeting insert failed: ${error.message}`)
  }

  logger.info('booking: meeting recorded', {
    organisation_id: organisation.id,
    meeting_id: data.id,
    prospect_match: match,
  })

  if (prospectId) {
    await sendFirstMeetingEmail({
      supabase,
      organisationId: organisation.id,
      meetingId: data.id,
      prospectId,
      scheduledStartAt: details.startTime ?? bookedAt,
      bookedAt,
    })
  } else {
    await sendUnmatchedBookingNotification({
      reason: 'no_prospect',
      organisationName: organisation.name,
      bookingUid: details.bookingUid,
      hostRef: details.hostRef,
      attendeeEmail: details.attendeeEmail,
      attendeeName: details.attendeeName,
      startTime: details.startTime,
    })
  }

  return { outcome: 'recorded', meetingId: data.id, prospectMatch: match }
}

async function quarantine(
  supabase: ServiceRoleClient,
  details: BookedDetails,
  provider: string,
): Promise<BookingOutcome> {
  const { error } = await supabase
    .from('unattributed_bookings')
    .insert({
      provider,
      provider_booking_uid: details.bookingUid,
      host_ref: details.hostRef,
      attendee_email: details.attendeeEmail,
      attendee_name: details.attendeeName,
      scheduled_start_at: details.startTime,
    })

  if (error) {
    if (error.code === UNIQUE_VIOLATION) return { outcome: 'duplicate' }
    throw new Error(`booking: quarantine insert failed: ${error.message}`)
  }

  logger.warn('booking: hosting seat belongs to no client, booking quarantined', {
    host_ref: details.hostRef,
    booking_uid: details.bookingUid,
  })

  await sendUnmatchedBookingNotification({
    reason: 'unknown_host',
    organisationName: null,
    bookingUid: details.bookingUid,
    hostRef: details.hostRef,
    attendeeEmail: details.attendeeEmail,
    attendeeName: details.attendeeName,
    startTime: details.startTime,
  })

  return { outcome: 'quarantined' }
}

// ── Cancelled ────────────────────────────────────────────────────────────────

async function recordCancelled(
  supabase: ServiceRoleClient,
  bookingUid: string,
  provider: string,
): Promise<BookingOutcome> {
  // Only a meeting still at 'booked' is cancelled. A meeting already decided held or
  // no-show is a person's judgement and a late cancellation does not overturn it.
  const { data: cancelled, error } = await supabase
    .from('meetings')
    .update({ meeting_status: 'canceled', is_billable: false })
    .eq('booking_uid', bookingUid)
    .eq('meeting_status', 'booked')
    .select('id')
  if (error) throw new Error(`booking: cancellation update failed: ${error.message}`)
  if (cancelled && cancelled.length > 0) return { outcome: 'cancelled', meetingId: cancelled[0].id }

  const { data: existing, error: readError } = await supabase
    .from('meetings')
    .select('id, meeting_status')
    .eq('booking_uid', bookingUid)
    .maybeSingle()
  if (readError) throw new Error(`booking: cancellation read failed: ${readError.message}`)
  if (existing) return { outcome: 'no_change', detail: `meeting is ${existing.meeting_status}, not booked` }

  const { data: quarantined, error: quarantineError } = await supabase
    .from('unattributed_bookings')
    .update({ cancelled_at: new Date().toISOString() })
    .eq('provider', provider)
    .eq('provider_booking_uid', bookingUid)
    .select('id')
  if (quarantineError) throw new Error(`booking: quarantine cancellation failed: ${quarantineError.message}`)
  if (quarantined && quarantined.length > 0) {
    return { outcome: 'no_change', detail: 'quarantined booking marked cancelled' }
  }

  logger.warn('booking: cancellation for a booking that was never recorded', { booking_uid: bookingUid })
  return { outcome: 'no_change', detail: 'no booking recorded under this uid' }
}

// ── Rescheduled ──────────────────────────────────────────────────────────────
//
// The booking tool issues a NEW uid for the rescheduled booking and names the old one. The
// meeting row is moved onto the new uid rather than duplicated. A meeting that was cancelled
// before this arrived is live again, so an undecided one goes back to 'booked'.

async function recordRescheduled(
  supabase: ServiceRoleClient,
  event: Extract<BookingEvent, { kind: 'rescheduled' }>,
  provider: string,
): Promise<BookingOutcome> {
  if (event.previousBookingUid) {
    const { data: moved, error } = await supabase
      .from('meetings')
      .update({
        booking_uid: event.bookingUid,
        scheduled_start_at: event.startTime,
        scheduled_end_at: event.endTime,
        // The deadline follows the meeting. Moved into a later month, the client gets the
        // longer window that month earns, which is what the calendar rule says. Only on the
        // undecided path: a meeting already decided keeps the deadline it was judged under.
        bill_unconfirmed_after: billingDeadlineFor(event.startTime, new Date().toISOString()),
        meeting_status: 'booked',
        is_billable: false,
        // A rescheduled meeting is unanswered again, so the asking starts over.
        outcome_requested_at: null,
        confirmation_sent_at: null,
        last_reminded_at: null,
        reminder_count: 0,
      })
      .eq('booking_uid', event.previousBookingUid)
      .eq('held_decision_locked', false)
      .select('id')
    if (error) {
      if (error.code === UNIQUE_VIOLATION) return { outcome: 'duplicate' }
      throw new Error(`booking: reschedule update failed: ${error.message}`)
    }
    if (moved && moved.length > 0) return { outcome: 'rescheduled', meetingId: moved[0].id }

    // A decided meeting keeps its decision; only the time and uid follow the booking.
    const { data: movedLocked, error: lockedError } = await supabase
      .from('meetings')
      .update({ booking_uid: event.bookingUid, scheduled_start_at: event.startTime })
      .eq('booking_uid', event.previousBookingUid)
      .select('id')
    if (lockedError) {
      if (lockedError.code === UNIQUE_VIOLATION) return { outcome: 'duplicate' }
      throw new Error(`booking: reschedule update failed: ${lockedError.message}`)
    }
    if (movedLocked && movedLocked.length > 0) return { outcome: 'rescheduled', meetingId: movedLocked[0].id }
  }

  // Nothing under the old uid. Either this delivery was already applied, or the original
  // was quarantined, or it was never seen at all.
  const { data: already, error: readError } = await supabase
    .from('meetings')
    .select('id')
    .eq('booking_uid', event.bookingUid)
    .maybeSingle()
  if (readError) throw new Error(`booking: reschedule read failed: ${readError.message}`)
  if (already) return { outcome: 'duplicate' }

  if (event.previousBookingUid) {
    const { data: movedQuarantine, error: quarantineError } = await supabase
      .from('unattributed_bookings')
      .update({ provider_booking_uid: event.bookingUid, scheduled_start_at: event.startTime, cancelled_at: null })
      .eq('provider', provider)
      .eq('provider_booking_uid', event.previousBookingUid)
      .select('id')
    if (quarantineError) {
      if (quarantineError.code === UNIQUE_VIOLATION) return { outcome: 'duplicate' }
      throw new Error(`booking: quarantine reschedule failed: ${quarantineError.message}`)
    }
    if (movedQuarantine && movedQuarantine.length > 0) {
      return { outcome: 'no_change', detail: 'quarantined booking rescheduled' }
    }
  }

  // Never seen before. Recorded as a new booking so it is not lost.
  return recordCreated(supabase, event, provider)
}

// ── The slot has passed: ASK A PERSON ────────────────────────────────────────
//
// This is the whole of what a meeting-ended notification is allowed to do. It stamps
// outcome_requested_at, which is what the daily sweep reads to send the client the
// one-click confirmation. It sets no status, no held decision and no billable flag, because
// the notification fires at the scheduled end time whether or not anyone turned up.
//
// Only an undecided, still-booked meeting is stamped, and only if it has not been stamped
// already, so a repeated delivery does not restart the asking or move the deadline.

async function recordEnded(
  supabase: ServiceRoleClient,
  bookingUid: string,
  endTime: string | null,
): Promise<BookingOutcome> {
  const patch: { outcome_requested_at: string; scheduled_end_at?: string } = {
    outcome_requested_at: new Date().toISOString(),
  }
  // The end time as the tool reported it at the time it actually ended, which is better
  // evidence than what was scheduled when the booking was taken.
  if (endTime) patch.scheduled_end_at = endTime

  const { data: asked, error } = await supabase
    .from('meetings')
    .update(patch)
    .eq('booking_uid', bookingUid)
    .eq('meeting_status', 'booked')
    .eq('held_decision_locked', false)
    .is('outcome_requested_at', null)
    .select('id')
  if (error) throw new Error(`booking: meeting-ended update failed: ${error.message}`)
  if (asked && asked.length > 0) {
    logger.info('booking: slot has passed, an outcome will be requested from the client', {
      meeting_id: asked[0].id,
      booking_uid: bookingUid,
    })
    return { outcome: 'outcome_requested', meetingId: asked[0].id }
  }

  // Nothing was stamped. Say WHICH of the harmless reasons it was, rather than reporting a
  // bare no-op: "already asked" and "no such booking" need different actions from a person.
  const { data: existing, error: readError } = await supabase
    .from('meetings')
    .select('id, meeting_status, held_decision_locked, outcome_requested_at')
    .eq('booking_uid', bookingUid)
    .maybeSingle()
  if (readError) throw new Error(`booking: meeting-ended read failed: ${readError.message}`)
  if (!existing) {
    logger.warn('booking: meeting-ended for a booking that was never recorded', { booking_uid: bookingUid })
    return { outcome: 'no_change', detail: 'no booking recorded under this uid' }
  }
  if (existing.outcome_requested_at) return { outcome: 'no_change', detail: 'an outcome was already requested' }
  if (existing.held_decision_locked) return { outcome: 'no_change', detail: 'the outcome is already decided' }
  return { outcome: 'no_change', detail: `meeting is ${existing.meeting_status}, not booked` }
}

// ── A host marked the attendee absent ───────────────────────────────────────
//
// The one attendance signal that is a human judgement rather than a clock: a host ticking
// "no-show" on the booking tool's past-bookings screen. It records a no-show and locks the
// decision, exactly as a client answering "it didn't happen" would.
//
// A no-show is NEVER billable, so is_billable stays false and billable_basis stays null. The
// database agrees: meetings_billable_records_its_basis means nothing can be billable without
// a basis, and no basis exists for "a host said nobody came".
//
// It does not overturn a decision already made. If the client has answered and the operator
// has locked it, a later mark in the booking tool is recorded in the log and not applied:
// letting a vendor webhook overwrite a human answer is how an outcome changes with nobody
// deciding it.

async function recordNoShowMarked(
  supabase: ServiceRoleClient,
  bookingUid: string,
): Promise<BookingOutcome> {
  const { data: marked, error } = await supabase
    .from('meetings')
    .update({
      meeting_status: 'no_show',
      held_confirmed_by: 'host',
      held_decision_locked: true,
      is_billable: false,
    })
    .eq('booking_uid', bookingUid)
    .eq('meeting_status', 'booked')
    .eq('held_decision_locked', false)
    .select('id')
  if (error) throw new Error(`booking: no-show update failed: ${error.message}`)
  if (marked && marked.length > 0) {
    logger.info('booking: host marked the attendee absent, recorded as a no-show', {
      meeting_id: marked[0].id,
      booking_uid: bookingUid,
    })
    return { outcome: 'no_show_recorded', meetingId: marked[0].id }
  }

  const { data: existing, error: readError } = await supabase
    .from('meetings')
    .select('id, meeting_status, held_confirmed_by')
    .eq('booking_uid', bookingUid)
    .maybeSingle()
  if (readError) throw new Error(`booking: no-show read failed: ${readError.message}`)
  if (!existing) {
    logger.warn('booking: no-show mark for a booking that was never recorded', { booking_uid: bookingUid })
    return { outcome: 'no_change', detail: 'no booking recorded under this uid' }
  }
  logger.info('booking: no-show mark arrived for a meeting already decided, not applied', {
    meeting_id: existing.id,
    decided_as: existing.meeting_status,
    decided_by: existing.held_confirmed_by,
  })
  return { outcome: 'no_change', detail: `meeting is already ${existing.meeting_status}` }
}
