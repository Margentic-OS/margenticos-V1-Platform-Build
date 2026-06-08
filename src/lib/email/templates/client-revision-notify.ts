// client-revision-notify: sent to the operator when a client submits a revision
// to any strategy document. Fires from the revision path (wired in S5).
// Operator-facing only — not seen by clients.
// Includes the client's revision note verbatim so the operator can verify the
// agent interpreted it correctly before approving the result.

const DOC_TYPE_LABELS: Record<string, string> = {
  icp:         'ICP',
  tov:         'Tone of voice',
  positioning: 'Positioning',
  messaging:   'Messaging',
}

interface ClientRevisionNotifyParams {
  orgName: string
  orgId: string
  docType: string
  revisionNote: string
}

export function clientRevisionNotifyTemplate({
  orgName,
  orgId,
  docType,
  revisionNote,
}: ClientRevisionNotifyParams): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.margenticos.com'
  const orgUrl = `${appUrl}/dashboard/operator?client=${orgId}`
  const label = DOC_TYPE_LABELS[docType] ?? docType
  const safeNote = revisionNote.slice(0, 1000)

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Client revision submitted — ${label}</title>
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
                Client revision submitted — ${label}
              </p>
              <p style="margin:0 0 16px;font-size:14px;color:#444;line-height:1.6;">
                <strong>${orgName}</strong> submitted a revision request for their
                <strong>${label}</strong> document. The revision agent has run and the updated
                document is ready to view.
              </p>
              <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#1a1a1a;">Revision note from client:</p>
              <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
                <tr>
                  <td style="background:#f9f7f3;border:1px solid #e0d9cc;border-radius:6px;padding:16px;">
                    <p style="margin:0;font-size:13px;color:#444;line-height:1.6;white-space:pre-wrap;">${safeNote}</p>
                  </td>
                </tr>
              </table>
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#2d5a27;border-radius:6px;">
                    <a href="${orgUrl}"
                       style="display:inline-block;padding:12px 24px;color:#f5f0e8;font-size:14px;font-weight:600;text-decoration:none;">
                      View updated document
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

export function clientRevisionNotifySubject(orgName: string, docType: string): string {
  const label = DOC_TYPE_LABELS[docType] ?? docType
  return `Client revision submitted — ${label} — ${orgName}`
}
