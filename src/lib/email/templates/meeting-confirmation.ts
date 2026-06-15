// Meeting confirmation email: transactional message asking client to confirm whether meeting was held.
// Signed-token link is scanner-safe: GET/HEAD does nothing, POST-only button click records the decision.
// Sign-off: company team (system message, not operator-reviewed).

interface MeetingConfirmationParams {
  clientName: string
  prospectName: string
  meetingDate: string // Human-readable date, e.g., "Monday, June 17 at 2:00 PM"
  windowClosesDate: string // Human-readable date, e.g., "Wednesday, June 19"
  confirmationUrl: string // Direct link to /confirm-meeting/[token]
  companyName: string
}

export function meetingConfirmationTemplate({
  clientName,
  prospectName,
  meetingDate,
  windowClosesDate,
  confirmationUrl,
  companyName,
}: MeetingConfirmationParams): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Did your meeting happen?</title>
</head>
<body style="margin:0;padding:0;background:#f5f0e8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f0e8;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #E8E2D8;">
          <tr>
            <td style="background:#1C3A2A;padding:24px 32px;">
              <p style="margin:0;color:#F5F0E8;font-size:13px;font-weight:500;letter-spacing:0.06em;text-transform:uppercase;">MargenticOS</p>
            </td>
          </tr>
          <tr>
            <td style="padding:40px 32px 32px;">
              <p style="margin:0 0 24px;font-size:16px;font-weight:500;color:#1A1916;line-height:1.4;">
                Hi ${clientName},
              </p>
              <p style="margin:0 0 20px;font-size:14px;color:#1A1916;line-height:1.6;">
                Your meeting with <strong>${prospectName}</strong> was scheduled for <strong>${meetingDate}</strong>. Let us know whether it went ahead.
              </p>
              <div style="background:#EAF3DE;border-left:3px solid #3B6D11;padding:16px 20px;margin:24px 0;border-radius:4px;">
                <p style="margin:0;font-size:13px;color:#1A1916;line-height:1.5;">
                  If the meeting didn't happen, just let us know by <strong>${windowClosesDate}</strong>.
                </p>
              </div>
              <table cellpadding="0" cellspacing="0" style="margin:32px 0;width:100%;">
                <tr>
                  <td align="center">
                    <table cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="background:#1C3A2A;border-radius:6px;margin-right:12px;">
                          <a href="${confirmationUrl}?decision=held"
                             style="display:inline-block;padding:12px 28px;color:#F5F0E8;font-size:14px;font-weight:500;text-decoration:none;">
                            Meeting happened
                          </a>
                        </td>
                        <td style="background:#FFFFFF;border:1px solid #E8E2D8;border-radius:6px;">
                          <a href="${confirmationUrl}?decision=no_show"
                             style="display:inline-block;padding:12px 28px;color:#1A1916;font-size:14px;font-weight:500;text-decoration:none;">
                            Didn't happen
                          </a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
              <p style="margin:32px 0 0;font-size:13px;color:#888;line-height:1.6;">
                Or visit this link to confirm:
              </p>
              <p style="margin:8px 0 32px;font-size:12px;color:#888;word-break:break-all;line-height:1.6;">
                ${confirmationUrl}
              </p>
              <hr style="border:none;border-top:1px solid #E8E2D8;margin:0 0 24px;" />
              <p style="margin:0;font-size:12px;color:#9A9488;line-height:1.6;">
                The MargenticOS team
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

export function meetingConfirmationSubject(): string {
  return 'Did your meeting happen?'
}
