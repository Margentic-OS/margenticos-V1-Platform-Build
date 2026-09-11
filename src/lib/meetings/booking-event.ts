// src/lib/meetings/booking-event.ts
//
// What a booking tool told us, in terms that name no booking tool.
//
// Each booking-tool handler (src/lib/integrations/handlers/<tool>/) turns its own
// notification into one of these. recordBookingEvent consumes them and never sees a vendor
// payload, which is what lets a second booking tool arrive as a new handler with nothing
// downstream of it changing (ADR-001).
//
// There is deliberately no "meeting ended" or "meeting held" event. A booking tool's
// meeting-ended notification fires at the scheduled end time whether or not anyone
// attended, so it says nothing about whether a meeting was held. Held stays an operator
// judgement (ADR-054). A handler that receives one returns it as ignored.

export interface BookedDetails {
  /** The booking tool's identifier for this booking. */
  bookingUid: string
  /** ISO timestamp of the scheduled start, as the tool reported it. */
  startTime: string | null
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
