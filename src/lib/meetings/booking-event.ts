// src/lib/meetings/booking-event.ts
//
// What a booking tool told us, in terms that name no booking tool.
//
// Each booking-tool handler (src/lib/integrations/handlers/<tool>/) turns its own
// notification into one of these. recordBookingEvent consumes them and never sees a vendor
// payload, which is what lets a second booking tool arrive as a new handler with nothing
// downstream of it changing (ADR-001).
//
// ═════════════════════════════════════════════════════════════════════════════
// "ENDED" IS NOT "HELD", AND NOTHING HERE MAY EVER TREAT IT AS ONE.
//
// A booking tool's meeting-ended notification fires at the scheduled end time whether or not
// anyone attended. It is evidence that the slot has passed, and evidence of nothing else. So
// 'ended' exists only to say "now is the time to ASK a person", and recordBookingEvent
// answers it by stamping outcome_requested_at. It never sets held, never sets billable.
//
// The automatic "didn't join" events some tools offer are not modelled at all: they require
// the tool's own video product, and our clients use their own Meet, Teams or Zoom, so those
// events will never fire for a client meeting. Designing around them would build a path that
// works only for us (ADR-057).
//
// 'no_show_marked' is the one attendance signal that IS a human judgement: a host marking an
// attendee absent on the booking tool's past-bookings screen. It can only ever record a
// no-show, which is never billable, so it cannot create revenue without a person.
// ═════════════════════════════════════════════════════════════════════════════

export interface BookedDetails {
  /** The booking tool's identifier for this booking. */
  bookingUid: string
  /** ISO timestamp of the scheduled start, as the tool reported it. */
  startTime: string | null
  /**
   * ISO timestamp of the scheduled END. Needed because "has this meeting finished?" cannot
   * be answered from the start alone without assuming a duration, and the confirmation ask
   * must not go out while the meeting is still running.
   */
  endTime: string | null
  /** The hosting seat, lowercased and trimmed; matched against organisations.booking_host_ref. */
  hostRef: string | null
  attendeeEmail: string | null
  attendeeName: string | null
  /** Our prospect reference, carried on the link and handed back by the tool. Untrusted. */
  prospectRef: string | null
}

export type BookingEvent =
  | ({ kind: 'created' } & BookedDetails)
  | ({ kind: 'rescheduled'; previousBookingUid: string | null } & BookedDetails)
  | { kind: 'cancelled'; bookingUid: string }
  /** The slot has passed. Ask a person. Never a statement that the meeting happened. */
  | { kind: 'ended'; bookingUid: string; endTime: string | null }
  /** A host marked an attendee absent. Records a no-show, and only ever a no-show. */
  | { kind: 'no_show_marked'; bookingUid: string; attendeeEmail: string | null }
