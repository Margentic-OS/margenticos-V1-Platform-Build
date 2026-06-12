import { getAppUrl } from '@/lib/urls/app-url'

export function versionPendingSubject(orgName: string, docType: string): string {
  const typeLabel = {
    icp: 'ICP',
    positioning: 'Positioning',
    tov: 'Tone of Voice',
    messaging: 'Messaging',
  }[docType] ?? 'Document'

  return `${typeLabel} has been updated`
}

export function versionPendingTemplate(params: {
  orgName: string
  docType: string
}): string {
  const appUrl = getAppUrl()
  const dashboardUrl = `${appUrl}/dashboard/documents`

  const typeLabel = {
    icp: 'ICP',
    positioning: 'Positioning',
    tov: 'Tone of Voice',
    messaging: 'Messaging',
  }[params.docType] ?? 'Document'

  return `<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: #1a1a1a; line-height: 1.6; max-width: 600px; margin: 0 auto; padding: 20px;">
  <p>Your ${typeLabel} document has been updated and needs your review.</p>
  <p><a href="${dashboardUrl}" style="display: inline-block; background-color: #000; color: #fff; padding: 10px 20px; text-decoration: none; border-radius: 4px; margin: 20px 0;">Review Updated Document</a></p>
  <p style="margin-top: 30px; color: #666; font-size: 14px;">
    ${params.orgName} Team
  </p>
</body>
</html>`
}
