// list-ready: sent to client when operator publishes a list for their review
// Event: operator publishes prospects to client
// Branded template with button and formatted text

export interface ListReadyParams {
  clientFirstName: string | null
  prospectCount: number
  reviewUrl: string
  lockDate: string  // formatted date e.g. "July 30"
}

export function listReadySubject(lockDate: string): string {
  return `${lockDate} is your review deadline`
}

export function listReadyTemplate(params: ListReadyParams): string {
  const greeting = params.clientFirstName ? `Hi ${params.clientFirstName}` : 'Hi'
  const countFormatted = params.prospectCount.toLocaleString('en-US')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${listReadySubject(params.lockDate)}</title>
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
                ${countFormatted} prospects ready for your review
              </p>
              <p style="margin:0 0 20px;font-size:14px;color:#444;line-height:1.6;">
                ${greeting}, we've sourced ${countFormatted} prospects against your Ideal Client Profile. Each one has been deduplicated, enriched, and email-verified.
              </p>
              <p style="margin:0 0 20px;font-size:14px;color:#444;line-height:1.6;">
                Review the list and reject anyone you don't want contacted: existing clients, live deals, competitors, or anyone you already know. This matters for two reasons. First, nobody gets an email from you who shouldn't. Second, you'll never be billed for a meeting with someone you didn't approve.
              </p>
              <p style="margin:0 0 24px;font-size:14px;color:#444;line-height:1.6;">
                Please review by ${params.lockDate}. After that we proceed with the list as it stands, so we stay on schedule for your send date.
              </p>
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#2d5a27;border-radius:6px;">
                    <a href="${params.reviewUrl}"
                       style="display:inline-block;padding:12px 24px;color:#f5f0e8;font-size:14px;font-weight:600;text-decoration:none;">
                      Review Prospects
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:24px 0 0;font-size:12px;color:#888;line-height:1.6;">
                Doug Pettit
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

export function listReadyTemplateText(params: ListReadyParams): string {
  const greeting = params.clientFirstName ? `Hi ${params.clientFirstName}` : 'Hi'
  const countFormatted = params.prospectCount.toLocaleString('en-US')

  return `${greeting}, we've sourced ${countFormatted} prospects against your Ideal Client Profile. Each one has been deduplicated, enriched, and email-verified.

Review the list and reject anyone you don't want contacted: existing clients, live deals, competitors, or anyone you already know. This matters for two reasons. First, nobody gets an email from you who shouldn't. Second, you'll never be billed for a meeting with someone you didn't approve.

Please review by ${params.lockDate}. After that we proceed with the list as it stands, so we stay on schedule for your send date.

Review Prospects: ${params.reviewUrl}

Doug Pettit`
}
