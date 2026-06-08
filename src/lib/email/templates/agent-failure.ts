// agent-failure: sent to the operator when a strategy document agent fails.
// Fires from each agent route's catch path.
// Operator-facing only — not seen by clients.

const DOC_TYPE_LABELS: Record<string, string> = {
  icp:         'ICP',
  tov:         'Tone of voice',
  positioning: 'Positioning',
  messaging:   'Messaging',
}

interface AgentFailureParams {
  orgName: string
  orgId: string
  docType: string
  error: string
}

export function agentFailureTemplate({ orgName, orgId, docType, error }: AgentFailureParams): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.margenticos.com'
  const orgUrl = `${appUrl}/dashboard/operator?client=${orgId}`
  const label = DOC_TYPE_LABELS[docType] ?? docType
  const safeError = error.slice(0, 500)

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${label} agent failed</title>
</head>
<body style="margin:0;padding:0;background:#f5f0e8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f0e8;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;">
          <tr>
            <td style="background:#7a2020;padding:24px 32px;">
              <p style="margin:0;color:#f5f0e8;font-size:13px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;">MargenticOS — Operator Alert</p>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <p style="margin:0 0 16px;font-size:18px;font-weight:600;color:#1a1a1a;">
                ${label} agent failed
              </p>
              <p style="margin:0 0 16px;font-size:14px;color:#444;line-height:1.6;">
                The <strong>${label}</strong> agent for <strong>${orgName}</strong> failed. The agent
                can be re-triggered manually from the client page.
              </p>
              <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
                <tr>
                  <td style="background:#fdf2f2;border:1px solid #f5c6c6;border-radius:6px;padding:16px;">
                    <p style="margin:0;font-size:12px;color:#7a2020;font-family:monospace;word-break:break-all;">${safeError}</p>
                  </td>
                </tr>
              </table>
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

export function agentFailureSubject(orgName: string, docType: string): string {
  const label = DOC_TYPE_LABELS[docType] ?? docType
  return `${label} agent failed — ${orgName}`
}
