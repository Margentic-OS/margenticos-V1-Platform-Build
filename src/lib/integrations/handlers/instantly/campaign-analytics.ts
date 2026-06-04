// src/lib/integrations/handlers/instantly/campaign-analytics.ts
//
// Fetches send/reply/bounce aggregates for all campaigns in the workspace.
// Calls GET /api/v2/campaigns/analytics with no campaign filter — one API
// call returns all campaigns, which is more efficient than per-campaign
// calls and reduces 429 risk.
//
// Returns a Map<externalId, CampaignStatResult> so the caller can do DB
// updates in a single loop without additional API calls.
//
// This file is the API boundary only. Field name translation from
// Instantly's schema (emails_sent_count, reply_count, bounced_count)
// to capability-facing names (sentCount, repliedCount, bouncedCount)
// happens here. Nothing above this file sees Instantly field names.

import { logger } from '@/lib/logger'
import { shouldUseMockDispatch } from './constants'
import { mockCampaignAnalytics } from './mock-dispatch'

export interface CampaignStatResult {
  sentCount:    number
  repliedCount: number
  bouncedCount: number
}

// Raw shape returned by Instantly's analytics endpoint (subset of fields we use)
interface InstantlyCampaignAnalyticsRow {
  campaign_id:          string
  emails_sent_count:    number
  reply_count:          number
  bounced_count:        number
}

// fetchCampaignStats — retrieves analytics for every campaign in the workspace.
// Returns a Map keyed by Instantly campaign UUID (matches campaigns.external_id).
// Throws on network error or non-2xx response so the caller can handle isolation.
export async function fetchCampaignStats(
  apiKey: string,
  isActive: boolean,
  baseUrl: string,
): Promise<Map<string, CampaignStatResult>> {
  let response: Response
  if (shouldUseMockDispatch(isActive)) {
    response = mockCampaignAnalytics()
  } else {
    try {
      response = await fetch(`${baseUrl}/campaigns/analytics`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      })
    } catch (err) {
      throw new Error(`Campaign analytics network error: ${String(err)}`)
    }
  }

  if (response.status === 429) {
    throw new Error('Campaign analytics rate limited (429) — caller should surface to operator')
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '(unreadable)')
    throw new Error(`Campaign analytics API error ${response.status}: ${body.slice(0, 200)}`)
  }

  let rows: unknown
  try {
    rows = await response.json()
  } catch {
    throw new Error('Campaign analytics response was not valid JSON')
  }

  if (!Array.isArray(rows)) {
    logger.warn('fetchCampaignStats: response was not an array', { type: typeof rows })
    return new Map()
  }

  const result = new Map<string, CampaignStatResult>()
  for (const row of rows) {
    const r = row as InstantlyCampaignAnalyticsRow
    if (!r.campaign_id) continue
    result.set(r.campaign_id, {
      sentCount:    r.emails_sent_count ?? 0,
      repliedCount: r.reply_count       ?? 0,
      bouncedCount: r.bounced_count     ?? 0,
    })
  }

  return result
}
