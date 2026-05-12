// intake-complete: sent to the operator when a client's intake crosses the 80%
// threshold and the four strategy agents are dispatched.
// Operator-facing only — not seen by clients.

interface IntakeCompleteParams {
  orgName: string
  orgId: string
}

export function intakeCompleteTemplate({ orgName, orgId }: IntakeCompleteParams): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.margenticos.com'
  const orgUrl = `${appUrl}/dashboard/operator?client=${orgId}`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Intake complete</title>
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
                Intake complete: ${orgName}
              </p>
              <p style="margin:0 0 16px;font-size:14px;color:#444;line-height:1.6;">
                The intake for <strong>${orgName}</strong> has crossed the 80% threshold.
                All four strategy agents have been dispatched and are running now.
              </p>
              <p style="margin:0 0 24px;font-size:14px;color:#444;line-height:1.6;">
                You will receive another email when all four documents are ready for review.
              </p>
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#2d5a27;border-radius:6px;">
                    <a href="${orgUrl}"
                       style="display:inline-block;padding:12px 24px;color:#f5f0e8;font-size:14px;font-weight:600;text-decoration:none;">
                      View organisation
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

export function intakeCompleteSubject(orgName: string): string {
  return `Intake complete: ${orgName} — agents dispatched`
}
