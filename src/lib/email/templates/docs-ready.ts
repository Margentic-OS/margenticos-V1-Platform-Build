import { getAppUrl } from '@/lib/urls/app-url'

export function docsReadySubject(orgName: string): string {
  return 'Your strategy documents are ready for review'
}

export function docsReadyTemplate(params: {
  orgName: string
  orgId: string
}): string {
  const appUrl = getAppUrl()
  const dashboardUrl = `${appUrl}/dashboard/documents`

  return `<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: #1a1a1a; line-height: 1.6; max-width: 600px; margin: 0 auto; padding: 20px;">
  <p>All four strategy documents for your campaigns have been generated and are ready for your review:</p>
  <ul style="margin: 20px 0;">
    <li>ICP: Who your ideal customers are and what matters most to them</li>
    <li>Positioning: What makes your offer distinct</li>
    <li>Tone of Voice: How you speak to your market</li>
    <li>Messaging: The core themes and angles for outreach</li>
  </ul>
  <p><a href="${dashboardUrl}" style="display: inline-block; background-color: #000; color: #fff; padding: 10px 20px; text-decoration: none; border-radius: 4px; margin: 20px 0;">Review Documents</a></p>
  <p style="margin-top: 30px; color: #666; font-size: 14px;">
    ${params.orgName} Team
  </p>
</body>
</html>`
}
