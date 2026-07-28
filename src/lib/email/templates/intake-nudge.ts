// intake-nudge: periodic reminder sent to client when intake is <80% complete
// Event: cron job triggered if intake_progress < 0.8 AND 48h since last activity
// Plain text, signed "Doug" — relationship email

export interface IntakeNudgeParams {
  clientFirstName: string | null
  completionPercent: number
  intakeUrl: string
  kickoffDate: string  // formatted date e.g. "July 30"
}

export function intakeNudgeSubject(): string {
  return `questionnaire's still open`
}

export function intakeNudgeTemplate(params: IntakeNudgeParams): string {
  const greeting = params.clientFirstName ? `Hi ${params.clientFirstName},\n\n` : ''
  const body = `${greeting}You've completed ${params.completionPercent}% of your intake questionnaire. No rush from my side except one thing. Our call on ${params.kickoffDate} runs through your finished strategy documents, and I can't build those without it. Takes about 25 minutes.

${params.intakeUrl}

Doug`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${intakeNudgeSubject()}</title>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="padding:20px;">
    <p style="margin:0 0 16px;font-size:15px;color:#333;line-height:1.6;white-space:pre-wrap;">${body}</p>
  </div>
</body>
</html>`
}

export function intakeNudgeTemplateText(params: IntakeNudgeParams): string {
  const greeting = params.clientFirstName ? `Hi ${params.clientFirstName},\n\n` : ''
  return `${greeting}You've completed ${params.completionPercent}% of your intake questionnaire. No rush from my side except one thing. Our call on ${params.kickoffDate} runs through your finished strategy documents, and I can't build those without it. Takes about 25 minutes.

${params.intakeUrl}

Doug`
}
