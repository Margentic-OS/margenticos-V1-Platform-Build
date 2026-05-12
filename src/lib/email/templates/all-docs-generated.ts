// all-docs-generated: sent to the operator when all four strategy documents
// (ICP, Positioning, TOV, Messaging) have finished generating.
// Operator-facing only — not seen by clients.

interface AllDocsGeneratedParams {
  orgName: string
  orgId: string
}

export function allDocsGeneratedTemplate({ orgName, orgId }: AllDocsGeneratedParams): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.margenticos.com'
  const orgUrl = `${appUrl}/dashboard/operator?client=${orgId}`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Documents ready</title>
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
                Documents ready: ${orgName}
              </p>
              <p style="margin:0 0 16px;font-size:14px;color:#444;line-height:1.6;">
                All four strategy documents for <strong>${orgName}</strong> have finished generating
                and are ready for your review.
              </p>
              <p style="margin:0 0 8px;font-size:14px;color:#444;line-height:1.6;">Documents to review:</p>
              <ul style="margin:0 0 24px;padding-left:20px;font-size:14px;color:#444;line-height:1.8;">
                <li>Ideal Client Profile (ICP)</li>
                <li>Positioning</li>
                <li>Tone of Voice</li>
                <li>Messaging Playbook</li>
              </ul>
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#2d5a27;border-radius:6px;">
                    <a href="${orgUrl}"
                       style="display:inline-block;padding:12px 24px;color:#f5f0e8;font-size:14px;font-weight:600;text-decoration:none;">
                      Review documents
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

export function allDocsGeneratedSubject(orgName: string): string {
  return `Documents ready: ${orgName} — all four strategy docs generated`
}
