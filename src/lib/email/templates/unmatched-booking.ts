// unmatched-booking: sent to the operator when a booking could not be tied to a prospect, or
// arrived from a booking-tool calendar that belongs to no client. The booking IS recorded in
// both cases; this email is how a person finds out it needs a look.
// Operator-facing only.

export interface UnmatchedBookingNotice {
  /** no_prospect: recorded as a meeting with no prospect. unknown_host: quarantined. */
  reason: 'no_prospect' | 'unknown_host'
  organisationName: string | null
  bookingUid: string
  hostRef: string | null
  attendeeEmail: string | null
  attendeeName: string | null
  startTime: string | null
}

// Every value below comes from whoever filled in the booking form, so it is escaped before
// it is placed in HTML.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Missing values read as words, never as a literal null the rendering check would reject.
function show(value: string | null): string {
  return value ? escapeHtml(value) : 'not given'
}

function formatStart(startTime: string | null): string {
  if (!startTime) return 'not given'
  const date = new Date(startTime)
  if (Number.isNaN(date.getTime())) return escapeHtml(startTime)
  return date.toLocaleString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short',
  })
}

export function unmatchedBookingSubject(notice: UnmatchedBookingNotice): string {
  return notice.reason === 'unknown_host'
    ? 'A booking arrived for a calendar that belongs to no client'
    : `A booking for ${notice.organisationName ?? 'a client'} matched no prospect`
}

function explanation(notice: UnmatchedBookingNotice): string {
  if (notice.reason === 'unknown_host') {
    return `Someone booked a meeting on a booking calendar that is not connected to any
      client, so it could not be recorded as anyone's meeting. It is being held in the
      unattributed bookings list rather than thrown away. The usual cause is that the
      client's booking calendar address has not been entered against their organisation
      yet. The calendar it arrived on is shown below.`
  }
  return `Someone booked a meeting with <strong>${show(notice.organisationName)}</strong>. It
      is recorded as a meeting, but it could not be matched to any prospect we contacted:
      the booking carried no prospect reference we recognised, and the email address they
      booked with matches no prospect of this client. It will not be billed automatically.
      Check who this is.`
}

function row(label: string, value: string, last = false): string {
  const border = last ? '' : 'border-bottom:1px solid #e5e7eb;'
  return `<tr>
                  <td style="padding:12px 16px;${border}">
                    <p style="margin:0;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">${label}</p>
                    <p style="margin:4px 0 0;font-size:14px;color:#1a1a1a;">${value}</p>
                  </td>
                </tr>`
}

export function unmatchedBookingTemplate(notice: UnmatchedBookingNotice): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Unmatched booking</title>
</head>
<body style="margin:0;padding:0;background:#f5f0e8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f0e8;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;">
          <tr>
            <td style="background:#7a2e2e;padding:24px 32px;">
              <p style="margin:0;color:#f5f0e8;font-size:13px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;">MargenticOS Operator alert</p>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <p style="margin:0 0 16px;font-size:18px;font-weight:600;color:#1a1a1a;">
                ${escapeHtml(unmatchedBookingSubject(notice))}
              </p>
              <p style="margin:0 0 16px;font-size:14px;color:#444;line-height:1.6;">
                ${explanation(notice)}
              </p>
              <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;" width="100%">
                ${row('Booked by', show(notice.attendeeName))}
                ${row('Their email', show(notice.attendeeEmail))}
                ${row('Meeting time', formatStart(notice.startTime))}
                ${row('Booking calendar', show(notice.hostRef))}
                ${row('Booking reference', show(notice.bookingUid), true)}
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}
