// warming-complete: sent to client when operator marks warmup/placement-test complete
// Event: operator sets organisations.warmup_completed_at
// Plain text, signed "Doug" — relationship email

export interface WarmingCompleteParams {
  sendDate: string  // formatted date e.g. "August 10"
}

export function warmingCompleteSubject(sendDate: string): string {
  return `warming's done. sending starts ${sendDate}`
}

export function warmingCompleteTemplate(params: WarmingCompleteParams): string {
  const body = `Your domains have finished warming and passed their placement checks. That means we can send at full volume without landing in spam. First emails go out ${params.sendDate}. From then on you'll see everything live in your dashboard. Who's been contacted, who's opened, who's replied. One thing worth setting expectations on. Replies build over the first few weeks rather than arriving on day one, because most sequences run several touches before someone responds. The quiet stretch you've just been through was the setup. This next bit is where it starts working.

Doug`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${warmingCompleteSubject(params.sendDate)}</title>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="padding:20px;">
    <p style="margin:0;font-size:15px;color:#333;line-height:1.6;white-space:pre-wrap;">${body}</p>
  </div>
</body>
</html>`
}

export function warmingCompleteTemplateText(params: WarmingCompleteParams): string {
  return `Your domains have finished warming and passed their placement checks. That means we can send at full volume without landing in spam. First emails go out ${params.sendDate}. From then on you'll see everything live in your dashboard — who's been contacted, who's opened, who's replied. One thing worth setting expectations on: replies build over the first few weeks rather than arriving on day one, because most sequences run several touches before someone responds. The quiet stretch you've just been through was the setup. This next bit is where it starts working.

Doug`
}
