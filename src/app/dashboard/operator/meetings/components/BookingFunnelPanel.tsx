// Speed to booking, and the drop-off that makes it honest. One panel, deliberately.
//
// A median over people who booked can only ever look good, and it IMPROVES AS CONVERSION
// FALLS: if only the fastest bookers still convert, the median drops and reads as a win.
// So it is never rendered without the never-booked list beside it, and the two come from
// one computation over one read.
//
// THREE COUNTS ARE RENDERED EVEN AT ZERO, and that is the point of them:
//   failed sends            the people who asked to book and got nothing. Filtering the
//                           never-booked list to successful sends drops them, and they are
//                           the most expensive rows here.
//   bookings with no prospect  cannot be tied to a link send, so they cannot carry an
//                           interval; without this they would leave the sample silently.
//   quarantined bookings    the same story from the other side.
// A count that only appears when it is non-zero is a count nobody looks for.

import type { BookingFunnel } from '@/lib/meetings/booking-funnel'

interface BookingFunnelPanelProps {
  funnel: BookingFunnel | null
  /** Set when the read failed. Rendered instead of zeros. */
  error?: string | null
  /** Resolves an organisation id to a name, for rows the panel did not fetch itself. */
  organisationName: (id: string) => string
  prospectLabel: (id: string) => string
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours < 24) return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

function formatWhen(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  }) + ' UTC'
}

export function BookingFunnelPanel({
  funnel,
  error,
  organisationName,
  prospectLabel,
}: BookingFunnelPanelProps) {
  if (error || !funnel) {
    return (
      <section className="border border-[#E8E2D8] rounded-[10px] p-5">
        <h2 className="text-[14px] font-medium text-[#1A1916] mb-1">Speed to booking</h2>
        <p className="text-[13px] text-red-700">
          These numbers could not be read, so none are shown rather than showing zeros. A
          zero here would read as &quot;nobody dropped off&quot;. The error was:{' '}
          {error ?? 'no data returned'}
        </p>
      </section>
    )
  }

  const {
    timeToBooking, medianMinutes, sampleSize, faultyIntervals,
    neverBooked, minimumAgeHours, failedSends,
    bookingsWithNoProspect, bookedWithoutLinkSend, unattributedBookings,
  } = funnel

  return (
    <section className="flex flex-col gap-6">
      <div>
        <h2 className="text-[14px] font-medium text-[#1A1916] mb-1">
          Speed to booking, and the drop-off
        </h2>
        <p className="text-[12px] text-[#6B6B6B]">
          Measured from the moment the booking link actually went out. Automatic replies only
          for now: an operator-approved draft can carry a link too, and nothing records
          whether it did, so those are not counted here.
        </p>
      </div>

      {/* ── Time to booking ──────────────────────────────────────────────── */}
      <div>
        <h3 className="text-[13px] font-medium text-[#1A1916] mb-1">
          Time to booking{' '}
          {medianMinutes === null ? (
            <span className="font-normal text-[#6B6B6B]">no bookings to measure yet</span>
          ) : (
            <span className="font-normal">
              median {formatMinutes(medianMinutes)}{' '}
              <span className="text-[#6B6B6B]">from n = {sampleSize}</span>
            </span>
          )}
        </h3>
        {sampleSize > 0 && sampleSize < 5 && (
          <p className="text-[12px] text-brand-amber mb-2">
            {sampleSize === 1
              ? 'One booking is not a median. Treat this as a single observation.'
              : `Only ${sampleSize} bookings behind this, so it will move a lot.`}
          </p>
        )}
        <p className="text-[12px] text-[#6B6B6B] mb-3">
          This counts only people who booked, so on its own it can only look good, and it
          improves if fewer people convert. Read it next to the list below.
        </p>

        {faultyIntervals > 0 && (
          <p className="text-[12px] font-medium text-red-700 mb-2">
            {faultyIntervals} booking(s) are dated BEFORE the link they are attributed to.
            Those are faults, not fast bookings: they carry no interval and are excluded from
            the median rather than counted as zero.
          </p>
        )}

        {timeToBooking.length === 0 ? (
          <p className="text-[12px] text-[#6B6B6B]">Nothing booked through a link yet.</p>
        ) : (
          <ul>
            {timeToBooking.map(row => (
              <li key={row.meetingId} className="border-b border-[#E8E2D8] py-2 flex flex-wrap justify-between gap-2">
                <span className="text-[12px] text-[#1A1916]">
                  {organisationName(row.organisationId)} · {prospectLabel(row.prospectId)}
                </span>
                <span className="text-[12px]">
                  {row.faulty ? (
                    <span className="text-red-700 font-medium">
                      booked before the link went out, fault
                    </span>
                  ) : (
                    <>
                      <span className="font-medium text-[#1A1916]">
                        {formatMinutes(row.minutes as number)}
                      </span>
                      <span className="text-[#6B6B6B]"> after the link, {formatWhen(row.bookedAt)}</span>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Linked and never booked ──────────────────────────────────────── */}
      <div>
        <h3 className="text-[13px] font-medium text-[#1A1916] mb-1">
          Sent a link, never booked ({neverBooked.length})
        </h3>
        <p className="text-[12px] text-[#6B6B6B] mb-3">
          Oldest link first. Only counted once the link is more than {minimumAgeHours} hours
          old, because someone linked this morning has not dropped off, they are still
          deciding.
        </p>
        {neverBooked.length === 0 ? (
          <p className="text-[12px] text-[#6B6B6B]">
            Nobody linked more than {minimumAgeHours} hours ago is still unbooked.
          </p>
        ) : (
          <ul>
            {neverBooked.map(row => (
              <li key={row.actionId} className="border-b border-[#E8E2D8] py-2 flex flex-wrap justify-between gap-2">
                <span className="text-[12px] text-[#1A1916]">
                  {organisationName(row.organisationId)} · {prospectLabel(row.prospectId)}
                </span>
                <span className="text-[12px] text-[#6B6B6B]">
                  link sent {formatWhen(row.linkSentAt)}, {row.hoursSinceLink}h ago
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── The counts that must never be absent ─────────────────────────── */}
      <div className="border border-[#E8E2D8] rounded-[8px] p-4 flex flex-col gap-2">
        <p className={`text-[12px] ${failedSends > 0 ? 'font-medium text-red-700' : 'text-[#6B6B6B]'}`}>
          Asked to book and the send failed: <strong>{failedSends}</strong>
          {failedSends > 0
            ? '. They received nothing, and they are not in the list above because that list counts links we actually sent. Chase these first.'
            : '. Shown even at zero, because the list above counts only links that actually sent, and these people would otherwise be invisible on the screen built to find them.'}
        </p>
        <p className={`text-[12px] ${bookingsWithNoProspect > 0 ? 'font-medium text-brand-amber' : 'text-[#6B6B6B]'}`}>
          Bookings with no prospect attached: <strong>{bookingsWithNoProspect}</strong>
          {bookingsWithNoProspect > 0
            ? '. These cannot be tied to a link, so they carry no interval, and the person who booked may still appear above as never booked.'
            : '.'}
        </p>
        <p className={`text-[12px] ${unattributedBookings > 0 ? 'font-medium text-brand-amber' : 'text-[#6B6B6B]'}`}>
          Bookings quarantined to no client: <strong>{unattributedBookings}</strong>.
        </p>
        <p className="text-[12px] text-[#6B6B6B]">
          Booked without us sending a link: <strong>{bookedWithoutLinkSend}</strong>. Not a
          drop-off, and not a measure of our speed, so kept out of the median.
        </p>
      </div>
    </section>
  )
}
