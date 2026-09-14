// meetings-due-to-bill: sent to the operator when meetings are within a week of billing
// unconfirmed, while there is still time to chase the client by hand.
// Operator-facing only.
//
// Two kinds of row appear here and they need different actions, so they are labelled rather
// than merged:
//   still time     the client was asked and has not answered. Chase them.
//   NEVER ASKED    the ask never went out, so the backstop will NOT bill this meeting. That
//                  is a fault to fix, not a client to chase.

export interface DueToBillRow {
  meetingId: string
  organisationName: string
  prospectName: string | null
  scheduledStartAt: string | null
  deadline: string
  daysLeft: number
  neverAsked: boolean
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Missing values read as words, never as a literal the rendering check would reject.
function show(value: string | null): string {
  return value ? escapeHtml(value) : 'not given'
}

function formatDate(value: string | null): string {
  if (!value) return 'not given'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return escapeHtml(value)
  return date.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  })
}

export function meetingsDueToBillSubject(rows: DueToBillRow[]): string {
  const neverAsked = rows.filter(row => row.neverAsked).length
  if (neverAsked > 0) {
    return `${rows.length} meeting(s) near the billing deadline, ${neverAsked} never asked`
  }
  return `${rows.length} meeting(s) will bill unconfirmed within ${Math.max(...rows.map(r => r.daysLeft))} days`
}

function row(entry: DueToBillRow): string {
  const label = entry.neverAsked
    ? '<span style="color:#7a2e2e;font-weight:600;">NEVER ASKED, will not bill</span>'
    : `${entry.daysLeft} day(s) left`
  return `<tr>
              <td style="padding:12px 16px;border-bottom:1px solid #e5e7eb;">
                <p style="margin:0;font-size:14px;color:#1a1a1a;font-weight:600;">${show(entry.organisationName)}</p>
                <p style="margin:4px 0 0;font-size:13px;color:#444;">
                  Prospect: ${show(entry.prospectName)}. Met ${formatDate(entry.scheduledStartAt)}.
                </p>
                <p style="margin:4px 0 0;font-size:13px;color:#444;">
                  Bills unconfirmed after ${formatDate(entry.deadline)}. ${label}.
                </p>
                <p style="margin:4px 0 0;font-size:12px;color:#6b7280;">Meeting ${escapeHtml(entry.meetingId)}</p>
              </td>
            </tr>`
}

export function meetingsDueToBillTemplate(rows: DueToBillRow[]): string {
  const neverAsked = rows.filter(entry => entry.neverAsked).length
  const explanation = neverAsked > 0
    ? `Some of these were never asked. The confirmation email did not go out, so the backstop
       will NOT bill them and they will sit unresolved until somebody acts. Check that
       JWT_SECRET is set and that the client has a working address on file.`
    : `These clients were asked and have not answered. If they still have not answered after
       the date shown, each meeting bills unconfirmed, which is the term agreed on 2026-08-24.
       There is still time to chase them.`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Meetings near the billing deadline</title>
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
                ${escapeHtml(meetingsDueToBillSubject(rows))}
              </p>
              <p style="margin:0 0 16px;font-size:14px;color:#444;line-height:1.6;">
                ${explanation}
              </p>
              <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;" width="100%">
                ${rows.map(row).join('\n')}
              </table>
              <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;">
                The same list is on the operator meetings screen, with the decision buttons.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}
