// client-welcome: sent to the founder when the operator creates their organisation.
// Contains the magic-link action_link from supabase.auth.admin.generateLink.
// Industry-agnostic copy — no consulting-specific language.
// No AI tells: no em dashes, no "seamless", no "leverage", etc.

interface ClientWelcomeParams {
  founderFirstName: string
  orgName: string
  actionLink: string
}

export function clientWelcomeTemplate({ founderFirstName, orgName, actionLink }: ClientWelcomeParams): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Welcome to MargenticOS</title>
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
              <p style="margin:0 0 24px;font-size:22px;font-weight:600;color:#1a1a1a;line-height:1.3;">
                Hi ${founderFirstName},
              </p>
              <p style="margin:0 0 16px;font-size:15px;color:#444;line-height:1.6;">
                Your MargenticOS account for <strong>${orgName}</strong> is ready.
              </p>
              <p style="margin:0 0 16px;font-size:15px;color:#444;line-height:1.6;">
                Click the button below to set up your account and access your dashboard.
                The link is valid for 24 hours.
              </p>
              <table cellpadding="0" cellspacing="0" style="margin:32px 0;">
                <tr>
                  <td style="background:#2d5a27;border-radius:6px;">
                    <a href="${actionLink}"
                       style="display:inline-block;padding:14px 28px;color:#f5f0e8;font-size:15px;font-weight:600;text-decoration:none;">
                      Set up my account
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 16px;font-size:13px;color:#888;line-height:1.6;">
                If the button does not work, copy and paste this link into your browser:
              </p>
              <p style="margin:0 0 32px;font-size:12px;color:#888;word-break:break-all;line-height:1.6;">
                ${actionLink}
              </p>
              <hr style="border:none;border-top:1px solid #eee;margin:0 0 24px;" />
              <p style="margin:0;font-size:13px;color:#aaa;line-height:1.6;">
                If you were not expecting this invitation, you can ignore this email.
                No action is required.
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

export function clientWelcomeSubject(orgName: string): string {
  return `Your ${orgName} account is ready`
}
