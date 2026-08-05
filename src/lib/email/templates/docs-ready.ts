import { getAppUrl } from '@/lib/urls/app-url'

export function docsReadySubject(): string {
  return 'Your strategy documents are ready for review'
}

export function docsReadyTemplate(params: {
  orgName: string
  orgId: string
}): string {
  const appUrl = getAppUrl()
  const dashboardUrl = `${appUrl}/dashboard/documents`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Your strategy documents are ready for review</title>
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
              <p style="margin:0 0 24px;font-size:18px;font-weight:600;color:#1a1a1a;line-height:1.3;">
                Your strategy documents are ready
              </p>
              <p style="margin:0 0 20px;font-size:14px;color:#444;line-height:1.6;">
                All four documents have been generated and are ready for your review and feedback.
              </p>
              <p style="margin:0 0 24px;font-size:14px;color:#444;line-height:1.8;">
                What's included:
              </p>
              <ul style="margin:0 0 24px;padding-left:20px;font-size:14px;color:#444;line-height:1.8;">
                <li style="margin-bottom:8px;">Ideal Client Profile: Who your best customers are and what matters most to them</li>
                <li style="margin-bottom:8px;">Positioning: What makes your offer distinct in your market</li>
                <li style="margin-bottom:8px;">Tone of Voice: How your brand speaks to your audience</li>
                <li>Messaging: The core themes and angles for your outreach</li>
              </ul>
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#2d5a27;border-radius:6px;">
                    <a href="${dashboardUrl}"
                       style="display:inline-block;padding:12px 24px;color:#f5f0e8;font-size:14px;font-weight:600;text-decoration:none;">
                      Review Documents
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

export function docsReadyTemplateText(params: {
  orgName: string
  orgId: string
}): string {
  const appUrl = getAppUrl()
  const dashboardUrl = `${appUrl}/dashboard/documents`

  return `Your strategy documents are ready

All four documents have been generated and are ready for your review and feedback.

What's included:

- Ideal Client Profile: Who your best customers are and what matters most to them
- Positioning: What makes your offer distinct in your market
- Tone of Voice: How your brand speaks to your audience
- Messaging: The core themes and angles for your outreach

Review Documents: ${dashboardUrl}`
}
