// first-reply: ONE email sent to client when first qualifying human reply arrives
// Event: first reply classified with intent in (positive, question, mild_objection)
// Branded email with HTML card template
// Suppressed: opt_out, out_of_office, unclear, hard_objection

export interface FirstReplyParams {
  prospectName?: string | null
  prospectCompany?: string | null
}

export function firstReplySubject(): string {
  return `first reply is in`
}

export function firstReplyTemplate(params: FirstReplyParams): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.margenticos.com'
  const dashboardUrl = `${appUrl}/dashboard`

  const prospectLine = params.prospectName
    ? `${params.prospectName}${params.prospectCompany ? ` at ${params.prospectCompany}` : ''}`
    : 'A prospect'

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>first reply is in</title>
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
                We've got our first one.
              </p>
              <p style="margin:0 0 16px;font-size:15px;color:#444;line-height:1.6;">
                ${prospectLine} just replied to your email. Real human, real conversation. After weeks of setup and preparation, the pipeline just went from theory to working.
              </p>
              <p style="margin:0 0 24px;font-size:15px;color:#444;line-height:1.6;">
                I'm handling the reply from here. This is the only reply notification you'll get from me. From now on you'll only hear from me when meetings are booked. All the reply activity lives in your dashboard if you want to follow along.
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

export function firstReplyTemplateText(params: FirstReplyParams): string {
  const prospectLine = params.prospectName
    ? `${params.prospectName}${params.prospectCompany ? ` at ${params.prospectCompany}` : ''}`
    : 'A prospect'

  return `We've got our first one.

${prospectLine} just replied to your email. Real human, real conversation. After weeks of setup and preparation, the pipeline just went from theory to working.

I'm handling the reply from here. This is the only reply notification you'll get from me. From now on you'll only hear from me when meetings are booked. All the reply activity lives in your dashboard if you want to follow along.

View dashboard: ${process.env.NEXT_PUBLIC_APP_URL || 'https://app.margenticos.com'}/dashboard`
}
