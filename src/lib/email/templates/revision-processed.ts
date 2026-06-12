export function revisionProcessedSubject(orgName: string, docType: string): string {
  const typeLabel = {
    icp: 'ICP',
    positioning: 'Positioning',
    tov: 'Tone of Voice',
    messaging: 'Messaging',
  }[docType] ?? 'Document'

  return `${typeLabel} updated: your revision is live`
}

export function revisionProcessedTemplate(params: {
  orgName: string
  docType: string
}): string {
  const typeLabel = {
    icp: 'ICP',
    positioning: 'Positioning',
    tov: 'Tone of Voice',
    messaging: 'Messaging',
  }[params.docType] ?? 'Document'

  return `<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: #1a1a1a; line-height: 1.6; max-width: 600px; margin: 0 auto; padding: 20px;">
  <p>Your requested revision to the ${typeLabel} document has been approved and is now live.</p>
  <p>Log in to your dashboard to review the updated document and begin using it in your campaigns.</p>
  <p style="margin-top: 30px; color: #666; font-size: 14px;">
    ${params.orgName} Team
  </p>
</body>
</html>`
}
