// warmup-halfway: sent to client ~17 days after email warmup starts
// Event: cron job triggered by organisations.warmup_started_at
// Plain text, signed "Doug" — relationship email

export interface WarmupHalfwayParams {
  sendDate: string  // formatted date e.g. "August 10"
}

export function warmupHalfwaySubject(): string {
  return `halfway through warming`
}

export function warmupHalfwayTemplate(params: WarmupHalfwayParams): string {
  const body = `Quick update. Your domains are about halfway through their warming cycle, on schedule. Nothing needed from you. Your list is approved, your sequences are written, and the only thing between here and your first sends is time. First emails go out around ${params.sendDate}.

Doug`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${warmupHalfwaySubject()}</title>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="padding:20px;">
    <p style="margin:0;font-size:15px;color:#333;line-height:1.6;white-space:pre-wrap;">${body}</p>
  </div>
</body>
</html>`
}

export function warmupHalfwayTemplateText(params: WarmupHalfwayParams): string {
  return `Quick update. Your domains are about halfway through their warming cycle, on schedule. Nothing needed from you. Your list is approved, your sequences are written, and the only thing between here and your first sends is time. First emails go out around ${params.sendDate}.

Doug`
}
