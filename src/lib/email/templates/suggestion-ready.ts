// suggestion-ready: sent to the operator when a strategy document agent completes
// and writes a suggestion row. Fires from each agent route's success path.
// Operator-facing only — not seen by clients.

const DOC_TYPE_LABELS: Record<string, string> = {
  icp:         'ICP',
  tov:         'Tone of voice',
  positioning: 'Positioning',
  messaging:   'Messaging',
}

interface SuggestionReadyParams {
  orgName: string
  orgId: string
  docType: string
}

export function suggestionReadyTemplate({ orgName, orgId, docType }: SuggestionReadyParams): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.margenticos.com'
  const orgUrl = `${appUrl}/dashboard/operator?client=${orgId}`
  const label = DOC_TYPE_LABELS[docType] ?? docType

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${label} ready to review</title>
</head>
<body style="margin:0;padding:0;background:#f5f0e8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f0e8;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;">
          <tr>
            <td style="background:#2d5a27;padding:24px 32px;">
              <p style="margin:0;color:#f5f0e8;font-size:13px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;">MargenticOS — Operator</p>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <p style="margin:0 0 16px;font-size:18px;font-weight:600;color:#1a1a1a;">
                ${label} ready to review
              </p>
              <p style="margin:0 0 24px;font-size:14px;color:#444;line-height:1.6;">
                The <strong>${label}</strong> document for <strong>${orgName}</strong> has finished
                generating and is ready for your review.
              </p>
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#2d5a27;border-radius:6px;">
                    <a href="${orgUrl}"
                       style="display:inline-block;padding:12px 24px;color:#f5f0e8;font-size:14px;font-weight:600;text-decoration:none;">
                      Review document
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

export function suggestionReadySubject(orgName: string, docType: string): string {
  const label = DOC_TYPE_LABELS[docType] ?? docType
  return `${label} ready to review — ${orgName}`
}
