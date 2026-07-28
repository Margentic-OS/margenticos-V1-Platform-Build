// first-meeting: branded email sent to client when first meeting is booked
// Event: first meeting record created for organisation
// Branded email with HTML card template

export interface FirstMeetingParams {
  prospectName?: string | null
  prospectTitle?: string | null
  prospectCompany?: string | null
  meetingTime: string // formatted date e.g. "30 July 2026 at 2:00 PM"
}

export function firstMeetingSubject(prospectCompany?: string | null): string {
  return prospectCompany ? `meeting booked: ${prospectCompany}` : `meeting booked`
}

export function firstMeetingTemplate(params: FirstMeetingParams): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.margenticos.com'
  const dashboardUrl = `${appUrl}/dashboard`

  const prospectLine = params.prospectName
    ? `${params.prospectName}${params.prospectTitle ? `, ${params.prospectTitle}` : ''}${params.prospectCompany ? ` at ${params.prospectCompany}` : ''}`
    : 'Your prospect'

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>meeting booked</title>
</head>
<body style="margin:0;padding:0;background:#f5f0e8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f0e8;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;">
          <tr>
            <td style="background:#2d5a27;padding:24px 32px;">
              <p style="margin:0;color:#f5f0e8;font-size:13px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;">MargenticOS</p>
            </td>
          </tr>
          <tr>
            <td style="padding:40px 32px 32px;">
              <p style="margin:0 0 24px;font-size:22px;font-weight:600;color:#1a1a1a;line-height:1.3;">
                Meeting booked.
              </p>
              <p style="margin:0 0 24px;font-size:15px;color:#444;line-height:1.6;">
                ${prospectLine}, ${params.meetingTime}. Details and reply history in your dashboard.
              </p>
              <table cellpadding="0" cellspacing="0" style="margin:24px 0;">
                <tr>
                  <td style="background:#2d5a27;border-radius:6px;">
                    <a href="${dashboardUrl}"
                       style="display:inline-block;padding:14px 28px;color:#f5f0e8;font-size:15px;font-weight:600;text-decoration:none;">
                      View dashboard
                    </a>
                  </td>
                </tr>
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

export function firstMeetingTemplateText(params: FirstMeetingParams): string {
  const prospectLine = params.prospectName
    ? `${params.prospectName}${params.prospectTitle ? `, ${params.prospectTitle}` : ''}${params.prospectCompany ? ` at ${params.prospectCompany}` : ''}`
    : 'Your prospect'

  return `Meeting booked.

${prospectLine}, ${params.meetingTime}. Details and reply history in your dashboard.

View dashboard: ${process.env.NEXT_PUBLIC_APP_URL || 'https://app.margenticos.com'}/dashboard`
}
