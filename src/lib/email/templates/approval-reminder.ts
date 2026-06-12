import { getAppUrl } from '@/lib/urls/app-url'

export function approvalReminderSubject(orgName: string): string {
  return `${orgName}: document suggestion auto-approving soon`
}

export function approvalReminderTemplate(params: {
  orgName: string
  docType: string
  autoApprovesAt: string
}): string {
  const appUrl = getAppUrl()
  const approvalsUrl = `${appUrl}/dashboard/operator/approvals`

  const typeLabel = {
    icp: 'ICP',
    positioning: 'Positioning',
    tov: 'Tone of Voice',
    messaging: 'Messaging',
  }[params.docType] ?? 'Document'

  return `<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: #1a1a1a; line-height: 1.6; max-width: 600px; margin: 0 auto; padding: 20px;">
  <p>${params.orgName}'s ${typeLabel} suggestion will be automatically approved at ${params.autoApprovesAt} unless you review it before then.</p>
  <p><a href="${approvalsUrl}" style="display: inline-block; background-color: #000; color: #fff; padding: 10px 20px; text-decoration: none; border-radius: 4px; margin: 20px 0;">Review Pending Approvals</a></p>
  <p style="margin-top: 30px; color: #666; font-size: 14px;">
    MargenticOS
  </p>
</body>
</html>`
}
