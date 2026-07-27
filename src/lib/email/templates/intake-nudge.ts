// intake-nudge: periodic reminder sent to client when intake is <80% complete
// Event: cron job triggered if intake_progress < 0.8 AND 48h since last activity
// Contains: friendly nudge + link to intake form

export interface IntakeNudgeParams {
  orgName: string
  completionPercent: number
}

export function intakeNudgeSubject(): string {
  return `Let's finish your intake questionnaire`
}

export function intakeNudgeTemplate(params: IntakeNudgeParams): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.margenticos.com'
  const intakeUrl = `${appUrl}/dashboard/intake`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Let's finish your intake questionnaire</title>
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
                Let's finish your intake
              </p>
              <p style="margin:0 0 16px;font-size:15px;color:#444;line-height:1.6;">
                You're ${params.completionPercent}% of the way through your intake questionnaire. Just a few more answers and we can unlock your AI-powered pipeline.
              </p>
              <p style="margin:0 0 24px;font-size:15px;color:#444;line-height:1.6;">
                The questions are quick — most teams finish in under 15 minutes. Pick up where you left off:
              </p>
              <table cellpadding="0" cellspacing="0" style="margin:24px 0;">
                <tr>
                  <td style="background:#2d5a27;border-radius:6px;">
                    <a href="${intakeUrl}"
                       style="display:inline-block;padding:14px 28px;color:#f5f0e8;font-size:15px;font-weight:600;text-decoration:none;">
                      Continue intake
                    </a>
                  </td>
                </tr>
              </table>
              <hr style="border:none;border-top:1px solid #eee;margin:0 0 24px;" />
              <p style="margin:0;font-size:13px;color:#aaa;line-height:1.6;">
                ${params.orgName} Team
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

export function intakeNudgeTemplateText(params: IntakeNudgeParams): string {
  return `Let's finish your intake

You're ${params.completionPercent}% of the way through your intake questionnaire. Just a few more answers and we can unlock your AI-powered pipeline.

The questions are quick — most teams finish in under 15 minutes. Pick up where you left off:

Continue intake: ${process.env.NEXT_PUBLIC_APP_URL || 'https://app.margenticos.com'}/dashboard/intake

${params.orgName} Team`
}
