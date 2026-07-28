// list-ready: sent to client when operator publishes a list for their review
// Event: operator publishes prospects to client
// Plain text, signed "Doug" — relationship email

export interface ListReadyParams {
  clientFirstName: string
  prospectCount: number
  reviewUrl: string
  lockDate: string  // formatted date e.g. "July 30"
}

export function listReadySubject(lockDate: string): string {
  return `your prospect list, needs approval by ${lockDate}`
}

export function listReadyTemplate(params: ListReadyParams): string {
  const body = `Hi ${params.clientFirstName},

${params.prospectCount} prospects sourced against your Prospect Profile, deduplicated, enriched, and email-verified. Names, companies and websites are all in your dashboard.

Have a look through and reject anyone you don't want contacted. That includes existing clients, live deals, competitors, or anyone you already know. This matters for two reasons. First, nobody gets an email from you who shouldn't. Second, you'll never be billed for a meeting with someone you didn't approve.

Please review by ${params.lockDate}. After that the list locks so we stay on schedule for your send date.

${params.reviewUrl}

Doug`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${listReadySubject(params.lockDate)}</title>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="padding:20px;">
    <p style="margin:0 0 16px;font-size:15px;color:#333;line-height:1.6;white-space:pre-wrap;">${body}</p>
  </div>
</body>
</html>`
}

export function listReadyTemplateText(params: ListReadyParams): string {
  return `Hi ${params.clientFirstName},

${params.prospectCount} prospects sourced against your Prospect Profile, deduplicated, enriched, and email-verified. Names, companies and websites are all in your dashboard.

Have a look through and reject anyone you don't want contacted. That includes existing clients, live deals, competitors, or anyone you already know. This matters for two reasons. First, nobody gets an email from you who shouldn't. Second, you'll never be billed for a meeting with someone you didn't approve.

Please review by ${params.lockDate}. After that the list locks so we stay on schedule for your send date.

${params.reviewUrl}

Doug`
}
