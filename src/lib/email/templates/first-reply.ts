// first-reply: celebratory email sent to client when first genuine human reply arrives
// Event: first reply classified with intent != (opt_out, out_of_office, unclear)
// Contains: sentiment-appropriate message (positive/question/objection variants)

export type FirstReplyVariant = 'positive' | 'question' | 'objection'

export interface FirstReplyParams {
  orgName: string
  variant: FirstReplyVariant
  prospectName?: string | null
  prospectCompany?: string | null
}

export function firstReplySubject(variant: FirstReplyVariant): string {
  switch (variant) {
    case 'positive':
      return `Someone wants to talk`
    case 'question':
      return `You've got a question to answer`
    case 'objection':
      return `Your prospect replied`
    default:
      return `You've got a reply`
  }
}

export function firstReplyTemplate(params: FirstReplyParams): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.margenticos.com'
  const dashboardUrl = `${appUrl}/dashboard`

  const prospectLine = params.prospectName
    ? `${params.prospectName}${params.prospectCompany ? ` at ${params.prospectCompany}` : ''}`
    : 'Your prospect'

  const bodyVariants = {
    positive: {
      headline: 'Someone wants to talk',
      body: `${prospectLine} replied with genuine interest in what you're building. This is a real opportunity to move the conversation forward.`,
      cta: 'View reply',
    },
    question: {
      headline: 'Someone asked a question',
      body: `${prospectLine} wants to know more about your offer. Their question is a chance to demonstrate why you're the right fit.`,
      cta: 'View question',
    },
    objection: {
      headline: 'Your prospect replied',
      body: `${prospectLine} pushed back, but they didn't say no. They're engaged enough to respond. That's progress.`,
      cta: 'View reply',
    },
  }

  const variant = params.variant
  const v = bodyVariants[variant] || bodyVariants.question

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${firstReplySubject(variant)}</title>
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
                ${v.headline}
              </p>
              <p style="margin:0 0 24px;font-size:15px;color:#444;line-height:1.6;">
                ${v.body}
              </p>
              <table cellpadding="0" cellspacing="0" style="margin:24px 0;">
                <tr>
                  <td style="background:#2d5a27;border-radius:6px;">
                    <a href="${dashboardUrl}"
                       style="display:inline-block;padding:14px 28px;color:#f5f0e8;font-size:15px;font-weight:600;text-decoration:none;">
                      ${v.cta}
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

export function firstReplyTemplateText(params: FirstReplyParams): string {
  const prospectLine = params.prospectName
    ? `${params.prospectName}${params.prospectCompany ? ` at ${params.prospectCompany}` : ''}`
    : 'Your prospect'

  const bodyVariants = {
    positive: {
      headline: 'Someone wants to talk',
      body: `${prospectLine} replied with genuine interest in what you're building. This is a real opportunity to move the conversation forward.`,
    },
    question: {
      headline: 'Someone asked a question',
      body: `${prospectLine} wants to know more about your offer. Their question is a chance to demonstrate why you're the right fit.`,
    },
    objection: {
      headline: 'Your prospect replied',
      body: `${prospectLine} pushed back, but they didn't say no. They're engaged enough to respond. That's progress.`,
    },
  }

  const variant = params.variant
  const v = bodyVariants[variant] || bodyVariants.question

  return `${v.headline}

${v.body}

View reply: ${process.env.NEXT_PUBLIC_APP_URL || 'https://app.margenticos.com'}/dashboard

${params.orgName} Team`
}
