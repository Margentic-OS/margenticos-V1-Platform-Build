// client-welcome: sent to the founder when the operator creates their organisation.
// Contains the invite OTP code from supabase.auth.admin.generateLink (email_otp field).
// No clickable token link — immune to Outlook Safe Links prefetch.
// Industry-agnostic copy — no consulting-specific language.
// No AI tells: no em dashes, no "seamless", no "leverage", etc.

interface ClientWelcomeParams {
  founderFirstName: string
  orgName: string
  otpCode: string
  loginUrl: string  // /login?email=...&invite=1 — non-consumable, safe for scanners
}

export function clientWelcomeTemplate({ founderFirstName, orgName, otpCode, loginUrl }: ClientWelcomeParams): string {
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
              <p style="margin:0 0 8px;font-size:15px;color:#444;line-height:1.6;">
                Enter this 8-digit code to access your dashboard:
              </p>
              <div style="background:#f5f0e8;border-radius:8px;padding:20px 32px;text-align:center;margin:16px 0 24px;">
                <span style="font-family:monospace;font-size:36px;font-weight:700;color:#1a1a1a;letter-spacing:0.18em;">${otpCode}</span>
              </div>
              <p style="margin:0 0 16px;font-size:15px;color:#444;line-height:1.6;">
                Go to your login page, enter your email address, and type the code above when prompted.
              </p>
              <table cellpadding="0" cellspacing="0" style="margin:24px 0;">
                <tr>
                  <td style="background:#2d5a27;border-radius:6px;">
                    <a href="${loginUrl}"
                       style="display:inline-block;padding:14px 28px;color:#f5f0e8;font-size:15px;font-weight:600;text-decoration:none;">
                      Go to login page
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 8px;font-size:13px;color:#888;line-height:1.6;">
                Or open this address in your browser:
              </p>
              <p style="margin:0 0 32px;font-size:12px;color:#888;word-break:break-all;line-height:1.6;">
                ${loginUrl}
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
