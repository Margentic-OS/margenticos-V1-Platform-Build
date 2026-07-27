// list-ready: sent to client when operator publishes a tier for their review
// Event: operator clicks "Publish to Client" for a tier
// Contains: tier summary, link to review page, deadline for auto-approval (4 days)

export interface ListReadyParams {
  orgName: string
  orgId: string
  tier: 'tier_1' | 'tier_2' | 'tier_3'
  publishedCount: number
  reviewDeadline: string // formatted date e.g. "30 July 2026"
}

export function listReadySubject(orgName: string): string {
  return `Your prospect list is ready for review`
}

export function listReadyTemplate(params: ListReadyParams): string {
  const tierLabels = {
    tier_1: 'Tier 1: Best Matches',
    tier_2: 'Tier 2: Good Fits',
    tier_3: 'Tier 3: Secondary Prospects',
  }

  const tierDescriptions = {
    tier_1: 'Verified email, seniority, headcount, industry match.',
    tier_2: 'Verified email, seniority, one or more relaxed firmographics.',
    tier_3: 'Verified email, seniority, significantly relaxed fit.',
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.margenticos.com'
  const reviewUrl = `${appUrl}/dashboard/prospect-tiers`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Your prospect list is ready for review</title>
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
                Your prospect list is ready
              </p>
              <p style="margin:0 0 16px;font-size:15px;color:#444;line-height:1.6;">
                We've prepared ${params.publishedCount} prospects in <strong>${tierLabels[params.tier]}</strong> for your review.
              </p>
              <p style="margin:0 0 16px;font-size:15px;color:#444;line-height:1.6;">
                ${tierDescriptions[params.tier]}
              </p>
              <p style="margin:0 0 24px;font-size:15px;color:#888;line-height:1.6;">
                Review by <strong>${params.reviewDeadline}</strong>. Any prospects you don't remove will be automatically approved and added to your campaign.
              </p>
              <table cellpadding="0" cellspacing="0" style="margin:24px 0;">
                <tr>
                  <td style="background:#2d5a27;border-radius:6px;">
                    <a href="${reviewUrl}"
                       style="display:inline-block;padding:14px 28px;color:#f5f0e8;font-size:15px;font-weight:600;text-decoration:none;">
                      Review prospects
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
