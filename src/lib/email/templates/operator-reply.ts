// operator-reply: sent to the OPERATOR every time a reply needs actioning.
//
// It replaces first-reply, which went to the CLIENT, fired once per organisation for ever,
// and whose copy promised exactly that: "This is the only reply notification you'll get
// from me." Both halves were wrong. The client's dashboard is the right surface for their
// replies and it already exists, and the person who has to act is the operator, who
// received nothing at all.
//
// Deliberately plain. This is an internal alert to one person who is about to go and do
// something, not marketing, so it carries the facts and a link and stops.

export interface OperatorReplyParams {
  clientName: string
  prospectName?: string | null
  prospectCompany?: string | null
  classifiedIntent?: string | null
}

function describeProspect(params: OperatorReplyParams): string {
  if (!params.prospectName) return 'A prospect'
  return params.prospectCompany
    ? `${params.prospectName} at ${params.prospectCompany}`
    : params.prospectName
}

// The intent as the classifier recorded it, made readable without inventing a mapping that
// would silently drift from the classifier's own vocabulary. An unknown value passes
// through rather than being dropped, because a label nobody recognises is a signal too.
function describeIntent(intent?: string | null): string {
  if (!intent) return 'unclassified'
  return intent.replace(/_/g, ' ')
}

export function operatorReplySubject(params: OperatorReplyParams): string {
  return `Reply to action: ${params.clientName}`
}

export function operatorReplyTemplate(params: OperatorReplyParams): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.margenticos.com'
  const queueUrl = `${appUrl}/dashboard/operator/triage`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Reply to action</title>
</head>
<body style="margin:0;padding:0;background:#f5f0e8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f0e8;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:10px;padding:32px;">
          <tr>
            <td style="font-size:16px;line-height:1.5;color:#1a1a1a;">
              <p style="margin:0 0 16px;font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#8a8a8a;">Reply to action</p>
              <p style="margin:0 0 16px;">${describeProspect(params)} replied to a ${params.clientName} campaign.</p>
              <p style="margin:0 0 16px;">Classified as <strong>${describeIntent(params.classifiedIntent)}</strong>. It is waiting in the reply queue.</p>
              <p style="margin:0 0 24px;">
                <a href="${queueUrl}" style="display:inline-block;padding:11px 20px;background:#1a1a1a;color:#ffffff;text-decoration:none;border-radius:6px;font-size:15px;">Open the reply queue</a>
              </p>
              <p style="margin:0;font-size:13px;color:#6a6a6a;">${queueUrl}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

export function operatorReplyTemplateText(params: OperatorReplyParams): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.margenticos.com'

  return `Reply to action

${describeProspect(params)} replied to a ${params.clientName} campaign.

Classified as ${describeIntent(params.classifiedIntent)}. It is waiting in the reply queue.

Open the reply queue: ${appUrl}/dashboard/operator/triage`
}
