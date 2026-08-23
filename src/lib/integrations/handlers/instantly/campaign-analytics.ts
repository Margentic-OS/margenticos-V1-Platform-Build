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
//
// The same rule now covers campaign STATUS. Instantly's numeric campaign_status is
// translated to our four-value column here, in the handler, and nothing above this file
// sees an Instantly status integer. Per CLAUDE.md, translation between a tool's
// taxonomy and ours is the handler's responsibility.

import { logger } from '@/lib/logger'
import { shouldUseMockDispatch } from './constants'
import { mockCampaignAnalytics } from './mock-dispatch'
import { InstantlyFlagError } from './types'

export interface CampaignStatResult {
  sentCount:    number
  repliedCount: number
  bouncedCount: number
  // Canonical status derived from Instantly's numeric campaign_status.
  // null means the row carried no campaign_status, or carried a value that is not in
  // the documented enum. Either way the caller must NOT write it. See mapCampaignStatus.
  status:       CampaignLocalStatus | null
  // The raw value, kept so the caller can name it in a log or an error without
  // reaching back into Instantly's field names itself.
  rawStatus:    number | null
}

// The four values campaigns.status is allowed to hold, enforced by campaigns_status_check.
export type CampaignLocalStatus = 'draft' | 'active' | 'paused' | 'completed'

// ── Instantly campaign_status, verified 2026-08-23 ────────────────────────────
//
// Source of truth: the official OpenAPI document at
// https://developer.instantly.ai/api-reference/openapi.json
// components.schemas.def-1 (title "Campaign"), properties.status.
// Declared as a CLOSED enum of exactly eight values, with x-enumDescriptions:
//
//     0  Draft                  -1  Accounts Unhealthy
//     1  Active                 -2  Bounce Protect
//     2  Paused                -99  Account Suspended
//     3  Completed
//     4  Running Subsequences
//
// Verified against the spec directly, not inferred. Worth stating why that mattered:
// the Instantly MCP tool description documents only "0=Draft, 1=Active, 2=Paused,
// 3=Completed". Mapping from that would have silently dropped four real states,
// including all three of the abnormal stops, which are the ones an operator most needs
// to see. Do not re-derive this enum from a tool description or from memory.
//
// A NOTE ON WHAT status MEANS. It is INTENT, not live sending state. The same schema
// carries a separate not_sending_status field (1 out of schedule, 2 waiting for leads,
// 3 daily limit met, 4 all accounts at daily limit, 99 error), so a campaign at status 1
// may still be sending nothing right now. Nothing here should be read as "mail is
// flowing". For that question the right call is GET /campaigns/{id}/sending-status,
// whose 'healthy' is the only unobstructed value. Not used here and not needed here:
// this maps intent onto our four-value column, nothing more.
const INSTANTLY_CAMPAIGN_STATUS: Readonly<Record<number, CampaignLocalStatus>> = {
  0:   'draft',
  1:   'active',
  2:   'paused',
  3:   'completed',

  // Primary sequence finished, child subsequences still running. Mapped to 'active'
  // because the campaign is still working: 'completed' would claim it has finished when
  // it has not. Instantly's docs are genuinely ambiguous about whether mail leaves the
  // workspace in this state, listing campaign_running_subsequences both as a reason a
  // campaign "is not sending" and as having "active child sequences". Treated as
  // still-running, which is the reading that cannot understate activity.
  4:   'active',

  // The three ABNORMAL STOPS. All collapse to 'paused' because campaigns_status_check
  // allows only four values and none of them means "stopped by Instantly against our
  // wishes". 'paused' is the honest closest fit: not sending, not finished.
  //
  // This LOSES INFORMATION, and the lost information is the urgent kind. An account
  // suspension reads in the dashboard exactly like an operator clicking pause. The
  // column cannot express the difference, so the caller logs a warning naming the real
  // state whenever one of these is seen: the value is degraded, the observability is
  // not. Widening campaigns_status_check is in BACKLOG.md; it is not done here because
  // it would change what the dashboard renders.
  [-1]:  'paused',   // Accounts Unhealthy
  [-2]:  'paused',   // Bounce Protect
  [-99]: 'paused',   // Account Suspended
}

// Instantly statuses that mean "stopped by Instantly", not "stopped by us". Callers use
// this to decide whether to log loudly, since all three store as plain 'paused'.
export const INSTANTLY_ABNORMAL_STOP_STATUSES: readonly number[] = [-1, -2, -99]

// Maps Instantly's numeric campaign_status onto our four-value column.
//
// Returns null for anything not in the documented enum, INCLUDING a string that looks
// like a number. Deliberately no coercion and no default: an unrecognised value means
// Instantly changed a closed enum, which is a schema change worth seeing, and defaulting
// it to 'draft' or 'active' would write a confident lie into a column the dashboard
// renders. Same reasoning as verifyLeadStatus in the poller.
export function mapCampaignStatus(raw: unknown): CampaignLocalStatus | null {
  if (typeof raw !== 'number') return null
  return INSTANTLY_CAMPAIGN_STATUS[raw] ?? null
}

// Raw shape returned by Instantly's analytics endpoint (subset of fields we use)
interface InstantlyCampaignAnalyticsRow {
  campaign_id:          string
  campaign_status:      number
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
  // Safety gate: flag off + INSTANTLY_API_BASE_URL pointing at production = misconfiguration.
  if (!isActive && !shouldUseMockDispatch(isActive) && baseUrl.includes('api.instantly.ai')) {
    throw new InstantlyFlagError('fetchCampaignStats: instantly_api_active is false — cannot call production Instantly')
  }

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
    const rawStatus = typeof r.campaign_status === 'number' ? r.campaign_status : null
    result.set(r.campaign_id, {
      sentCount:    r.emails_sent_count ?? 0,
      repliedCount: r.reply_count       ?? 0,
      bouncedCount: r.bounced_count     ?? 0,
      status:       mapCampaignStatus(r.campaign_status),
      rawStatus,
    })
  }

  return result
}
