// multi-user-signup-attempt: sent to the operator when someone attempts
// to create an account for an organisation that already has a client user.
// Used so the operator can manually review and handle the request.
// Operator-facing only — not seen by the person who attempted to sign up.

interface MultiUserSignupAttemptParams {
  attemptedEmail: string
  orgId: string
  orgName: string
  attemptedAt: string
}

export function multiUserSignupAttemptTemplate({
  attemptedEmail,
  orgId,
  orgName,
  attemptedAt,
}: MultiUserSignupAttemptParams): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.margenticos.com'
  const orgUrl = `${appUrl}/dashboard/operator?client=${orgId}`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Multi-user signup attempt</title>
</head>
<body style="margin:0;padding:0;background:#f5f0e8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f0e8;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;">
          <tr>
            <td style="background:#7a2e2e;padding:24px 32px;">
              <p style="margin:0;color:#f5f0e8;font-size:13px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;">MargenticOS — Operator alert</p>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <p style="margin:0 0 16px;font-size:18px;font-weight:600;color:#1a1a1a;">
                Multi-user signup attempt blocked
              </p>
              <p style="margin:0 0 16px;font-size:14px;color:#444;line-height:1.6;">
                Someone tried to create an account linked to <strong>${orgName}</strong>,
                but that organisation already has a client user. The attempt was blocked.
              </p>
              <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;" width="100%">
                <tr>
                  <td style="padding:12px 16px;background:#f9fafb;border-bottom:1px solid #e5e7eb;">
                    <p style="margin:0;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">Attempted email</p>
                    <p style="margin:4px 0 0;font-size:14px;color:#1a1a1a;">${attemptedEmail}</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:12px 16px;border-bottom:1px solid #e5e7eb;">
                    <p style="margin:0;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">Organisation</p>
                    <p style="margin:4px 0 0;font-size:14px;color:#1a1a1a;">${orgName}</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:12px 16px;">
                    <p style="margin:0;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">Attempted at</p>
                    <p style="margin:4px 0 0;font-size:14px;color:#1a1a1a;">${attemptedAt}</p>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 8px;font-size:14px;color:#444;line-height:1.6;">
                If this is a legitimate request (e.g. a team member joining), review it in the operator dashboard.
              </p>
              <p style="margin:0 0 24px;font-size:14px;color:#444;line-height:1.6;">
                If you do not recognise this email address: an auth record was created for it but has no
                associated organisation access. You may manually delete it from Supabase Dashboard
                → Authentication if desired. (Automated cleanup of orphaned auth records is on the backlog.)
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

export function multiUserSignupAttemptSubject(orgName: string): string {
  return `Action needed: multi-user signup attempt blocked for ${orgName}`
}
