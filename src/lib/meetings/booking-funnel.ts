// Two measurements that only mean anything together.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY ONE MODULE AND ONE SCREEN, NOT TWO
//
// TIME TO BOOKING is a median over people who booked. It therefore counts only successes,
// and it can only ever look good. Worse, it IMPROVES AS CONVERSION FALLS: if the only
// people who still book are the ones who book fast, the median drops and the number reads
// as a win. On its own it is not a speed-to-lead measurement, it is a survivorship
// artefact.
//
// LINKED AND NEVER BOOKED is the denominator that makes it honest. One module computes
// both from the same inputs in one pass, so the two can never be rendered from different
// reads or different windows, and nothing can show one without the other.
//
// ═════════════════════════════════════════════════════════════════════════════
// FOUR WAYS THIS COULD LOOK HEALTHY WHILE IT IS NOT, AND WHAT IS DONE ABOUT EACH
//
// 1. A FAILED SEND DISAPPEARING. "Was sent a link" must mean the provider accepted it, so
//    the never-booked list is built from successful sends only. That silently drops every
//    prospect who asked to book and got nothing, which is the most expensive drop-off there
//    is and the exact population a never-booked screen exists to find. So failedSends is
//    counted separately and the screen renders it ALWAYS, including at zero.
//
// 2. A BOOKING WITH NO PROSPECT. An unmatched booking cannot be joined to the link send
//    that produced it, so it would fall out of the sample without trace, and the prospect
//    who booked would go on looking like a drop-off. Counted as bookingsWithNoProspect and
//    surfaced rather than dropped.
//
// 3. A NEGATIVE INTERVAL. If a booking predates the link send it is attributed to, the
//    interval is negative. Clamping it to zero would quietly make the median faster, which
//    is the direction that flatters. It is recorded as a FAULT, excluded from the median,
//    and counted so it is visible.
//
// 4. NO MINIMUM AGE. A prospect linked ten minutes ago has not dropped off. Without a floor
//    the never-booked count is inflated by everyone who is simply still deciding; with too
//    generous a floor it shrinks to nothing. MINIMUM_AGE_HOURS is stated on the screen so
//    the reader knows which number they are looking at.
//
// TIER 1 ONLY, AND THE SCREEN SAYS SO. Only the automatic send path writes link_sent_at.
// An operator-approved draft (Tier 2/3) can also carry a booking link and records no fact
// about whether it did: reply_drafts has no such column, and the body would have to be
// searched for the organisation's own URL. No draft has ever reached 'sent', so the
// population is complete today, and it stops being complete the moment one does.

import type { ServiceRoleClient } from '@/lib/supabase/service-role'

/** A prospect linked less recently than this is a drop-off; more recently, still deciding. */
export const MINIMUM_AGE_HOURS = 24

const MS_PER_MINUTE = 60 * 1000

/** One row of reply_handling_actions, narrowed to what the funnel reads. */
export interface LinkSend {
  actionId: string
  organisationId: string
  prospectId: string | null
  /** Written once at send time, and only when the provider accepted. NULL: nothing sent. */
  linkSentAt: string | null
  actionSucceeded: boolean | null
}

/** One booked meeting, narrowed to what the funnel reads. */
export interface Booking {
  meetingId: string
  organisationId: string
  prospectId: string | null
  bookedAt: string
}

export interface TimeToBookingRow {
  meetingId: string
  organisationId: string
  prospectId: string
  linkSentAt: string
  bookedAt: string
  /** Whole minutes from link to booking. NULL when the interval is a fault. */
  minutes: number | null
  /** The booking predates the link send it is attributed to. Never clamped away. */
  faulty: boolean
}

export interface NeverBookedRow {
  actionId: string
  organisationId: string
  prospectId: string
  linkSentAt: string
  /** Whole hours since the link went out, for an oldest-first list. */
  hoursSinceLink: number
}

export interface BookingFunnel {
  /** One row per booking that can be tied to a link send. Faults included, flagged. */
  timeToBooking: TimeToBookingRow[]
  /** Median whole minutes across the sound intervals only. NULL when the sample is empty. */
  medianMinutes: number | null
  /** n. Stated on the screen, because a median over one booking is not a median. */
  sampleSize: number
  /** Negative intervals. Visible, never clamped, never in the median. */
  faultyIntervals: number
  /** Linked, past the minimum age, and no booking of any kind. Oldest link first. */
  neverBooked: NeverBookedRow[]
  minimumAgeHours: number
  /** Asked to book and the send failed. Rendered always, including at zero. */
  failedSends: number
  /** Bookings with no prospect attached, which cannot enter the sample. */
  bookingsWithNoProspect: number
  /** Bookings by a prospect we never sent a link to. Not a drop-off and not our speed. */
  bookedWithoutLinkSend: number
  /** Quarantined bookings, read straight through: an unmatched booking is the same story. */
  unattributedBookings: number
}

function key(organisationId: string, prospectId: string): string {
  return `${organisationId}:${prospectId}`
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

function parsed(iso: string | null): number | null {
  if (!iso) return null
  const value = new Date(iso).getTime()
  return Number.isNaN(value) ? null : value
}

/**
 * Both measurements, from one set of inputs, in one pass.
 *
 * `unattributedBookings` is passed in rather than derived: it lives in its own table and is
 * carried here so the screen cannot show a never-booked list without it.
 */
export function computeBookingFunnel(
  input: {
    linkSends: LinkSend[]
    bookings: Booking[]
    unattributedBookings: number
  },
  now: Date = new Date(),
): BookingFunnel {
  const { linkSends, bookings, unattributedBookings } = input

  // A link send counts as a send only when the provider accepted it AND the timestamp was
  // written. Anything else is either a failure or a row from before this column existed.
  const successfulSends = linkSends.filter(
    send => send.actionSucceeded === true && parsed(send.linkSentAt) !== null && send.prospectId,
  )

  // Rule 1. Counted from the action row, NOT inferred from the absence of a send timestamp,
  // so a row that failed before the provider was even called is still counted.
  const failedSends = linkSends.filter(send => send.actionSucceeded === false).length

  const sendsByProspect = new Map<string, LinkSend[]>()
  for (const send of successfulSends) {
    const k = key(send.organisationId, send.prospectId as string)
    const list = sendsByProspect.get(k) ?? []
    list.push(send)
    sendsByProspect.set(k, list)
  }
  for (const list of sendsByProspect.values()) {
    list.sort((a, b) => (parsed(a.linkSentAt) as number) - (parsed(b.linkSentAt) as number))
  }

  const timeToBooking: TimeToBookingRow[] = []
  const bookedProspects = new Set<string>()
  let bookingsWithNoProspect = 0
  let bookedWithoutLinkSend = 0

  for (const booking of bookings) {
    const bookedAt = parsed(booking.bookedAt)
    if (bookedAt === null) continue

    // Rule 2. No prospect, so no link send can be attributed. Counted, never dropped.
    if (!booking.prospectId) {
      bookingsWithNoProspect++
      continue
    }

    const k = key(booking.organisationId, booking.prospectId)
    bookedProspects.add(k)

    const sends = sendsByProspect.get(k) ?? []
    if (sends.length === 0) {
      // They booked without us sending a link. Not a drop-off, and not a measure of our
      // speed either, so it is counted and kept out of the median.
      bookedWithoutLinkSend++
      continue
    }

    // The latest send at or before the booking is the one that plausibly produced it. When
    // every send came AFTER the booking, the earliest is used and the row is a fault: the
    // alternative is dropping it, which hides the disorder rather than showing it.
    const atOrBefore = sends.filter(send => (parsed(send.linkSentAt) as number) <= bookedAt)
    const chosen = atOrBefore.length > 0 ? atOrBefore[atOrBefore.length - 1] : sends[0]
    const sentAt = parsed(chosen.linkSentAt) as number

    const rawMinutes = (bookedAt - sentAt) / MS_PER_MINUTE
    const faulty = rawMinutes < 0

    timeToBooking.push({
      meetingId: booking.meetingId,
      organisationId: booking.organisationId,
      prospectId: booking.prospectId,
      linkSentAt: chosen.linkSentAt as string,
      bookedAt: booking.bookedAt,
      // Rule 3. NULL rather than a clamped zero. A negative interval is a fault to look at,
      // not a fast booking.
      minutes: faulty ? null : Math.round(rawMinutes),
      faulty,
    })
  }

  const soundIntervals = timeToBooking
    .filter(row => !row.faulty && row.minutes !== null)
    .map(row => row.minutes as number)

  // Rule 4. Linked, never booked, and old enough to be a drop-off rather than a decision in
  // progress.
  const ageFloor = now.getTime() - MINIMUM_AGE_HOURS * 60 * MS_PER_MINUTE
  const neverBooked: NeverBookedRow[] = []
  for (const [k, sends] of sendsByProspect) {
    if (bookedProspects.has(k)) continue
    const earliest = sends[0]
    const sentAt = parsed(earliest.linkSentAt) as number
    if (sentAt > ageFloor) continue
    neverBooked.push({
      actionId: earliest.actionId,
      organisationId: earliest.organisationId,
      prospectId: earliest.prospectId as string,
      linkSentAt: earliest.linkSentAt as string,
      hoursSinceLink: Math.floor((now.getTime() - sentAt) / (60 * MS_PER_MINUTE)),
    })
  }
  neverBooked.sort((a, b) => b.hoursSinceLink - a.hoursSinceLink)

  return {
    timeToBooking: timeToBooking.sort((a, b) => b.bookedAt.localeCompare(a.bookedAt)),
    medianMinutes: median(soundIntervals),
    sampleSize: soundIntervals.length,
    faultyIntervals: timeToBooking.filter(row => row.faulty).length,
    neverBooked,
    minimumAgeHours: MINIMUM_AGE_HOURS,
    failedSends,
    bookingsWithNoProspect,
    bookedWithoutLinkSend,
    unattributedBookings,
  }
}

/**
 * Reads what the funnel needs and computes it. Cross-organisation on purpose: this is the
 * operator's screen.
 *
 * A FAILED READ IS NOT A SET OF ZEROS. postgrest turns a refusal, a timeout and a network
 * failure alike into { data: null, error }, and `?? []` would render every one of them as
 * "nobody has booked and nobody has dropped off", which is the most reassuring possible lie
 * on a screen built to find drop-offs. The error is returned so the page can say so.
 */
export async function readBookingFunnel(
  db: ServiceRoleClient,
  now: Date = new Date(),
): Promise<{ funnel: BookingFunnel; error: null } | { funnel: null; error: string }> {
  const [sendsResult, bookingsResult, quarantineResult] = await Promise.all([
    db
      .from('reply_handling_actions')
      .select('id, organisation_id, prospect_id, link_sent_at, action_succeeded')
      .eq('action_taken', 'send_reply'),
    db.from('meetings').select('id, organisation_id, prospect_id, booked_at'),
    db.from('unattributed_bookings').select('*', { count: 'exact', head: true }),
  ])

  if (sendsResult.error) return { funnel: null, error: `link sends: ${sendsResult.error.message}` }
  if (bookingsResult.error) return { funnel: null, error: `bookings: ${bookingsResult.error.message}` }
  if (quarantineResult.error) return { funnel: null, error: `quarantined bookings: ${quarantineResult.error.message}` }

  const linkSends: LinkSend[] = (sendsResult.data ?? []).map(row => ({
    actionId: row.id,
    organisationId: row.organisation_id,
    prospectId: row.prospect_id,
    linkSentAt: row.link_sent_at,
    actionSucceeded: row.action_succeeded,
  }))

  const bookings: Booking[] = (bookingsResult.data ?? []).map(row => ({
    meetingId: row.id,
    organisationId: row.organisation_id,
    prospectId: row.prospect_id,
    bookedAt: row.booked_at,
  }))

  return {
    funnel: computeBookingFunnel(
      { linkSends, bookings, unattributedBookings: quarantineResult.count ?? 0 },
      now,
    ),
    error: null,
  }
}
