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
// Instantly's schema (emails_sent_count, reply_count, bounced_count,
// new_leads_contacted_count, leads_count, unsubscribed_count) to capability-facing
// names (sentCount, repliedCount, bouncedCount, contactedCount, leadsCount,
// unsubscribedCount) happens here. Nothing above this file sees Instantly field names.
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
  // PEOPLE with at least one send. Read from new_leads_contacted_count, NOT from
  // contacted_count. See the block below for the measurement that forced that choice.
  //
  // null means the row's people count was missing or incoherent (larger than leads_count,
  // which cannot happen for a count of people). The caller must NOT write it. Same
  // contract, and the same reasoning, as `status` below.
  contactedCount:    number | null
  // Total leads on the campaign, contacted or not. Carried so the caller can name it in a
  // log, and used here as the coherence bound on contactedCount.
  leadsCount:        number | null
  unsubscribedCount: number
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

// ── Which field is PEOPLE, measured 2026-09-03 ────────────────────────────────
//
// Instantly's OpenAPI document describes contacted_count as "Number of leads for whom
// the sequence has started". That description is wrong, and reading it instead of
// measuring it is what put a count of emails on a client's dashboard under the words
// "prospects contacted".
//
// One live campaign, read from GET /campaigns/analytics on 2026-09-03:
//
//     leads_count                 24
//     new_leads_contacted_count   24
//     contacted_count             52     <- cannot be people: 52 > 24 leads
//     emails_sent_count           60
//
// contacted_count exceeds the number of leads that exist, so it is not a count of
// people whatever the documentation says.
//
// WHAT IT IS INSTEAD IS NOT KNOWN, AND THAT IS THE POINT. The obvious reading, that it
// is really an email counter, does NOT survive the evidence. The same campaign was
// captured on 2026-08-24 in docs/DISCOVERY-per-domain-health.md reporting leads_count 15,
// contacted_count 15 and emails_sent_count 30, so on that day it equalled the people
// count exactly and was nowhere near the email count. Nine days later it reads 52 against
// 24 leads and 60 emails.
//
// So the field is not consistently either thing. It agreed with people once and cannot
// possibly be people now. A number that is right some of the time is the worst kind to
// render, because it is correct whenever anyone checks it casually. Do not use it, and do
// not spend time deducing what it counts: the bound below makes that unnecessary.
//
// new_leads_contacted_count is the people number, and it was confirmed against two
// independent ground truths on the same campaign rather than against the documentation:
//
//   - GET /leads/list filtered FILTER_VAL_CONTACTED returned exactly 24 leads with 24
//     distinct email addresses, and an empty second page.
//   - GET /campaigns/analytics/steps showed sends of 24 / 23 / 13 across the three
//     steps, summing to the 60 emails. Step one's 24 is every person who has had at
//     least one send.
//
// DO NOT re-derive this from the OpenAPI description or from a field name. The
// description is the thing that was wrong.
//
// Raw shape returned by Instantly's analytics endpoint (subset of fields we use)
interface InstantlyCampaignAnalyticsRow {
  campaign_id:                string
  campaign_status:            number
  emails_sent_count:          number
  reply_count:                number
  bounced_count:              number
  leads_count:                number
  new_leads_contacted_count:  number
  unsubscribed_count:         number
}

// mapContactedCount — the people count, or null when it cannot be one.
//
// Returns null rather than a fallback for the same reason mapCampaignStatus does: the
// caller renders this to a client as "prospects contacted", and a wrong number there is
// worse than a stale one. Two ways it refuses:
//
//   - the field is absent or not a number, so there is nothing to write
//   - it exceeds leads_count, which is incoherent for a count of people and is exactly
//     the shape the old contacted_count mapping produced (52 contacted, 24 leads)
//
// The bound is the guard that would have caught this defect on the day it shipped, so it
// stays even though the field it now reads is the right one. It is the part of this fix
// that does not depend on trusting a provider field's meaning, which matters because the
// last field we trusted agreed with the people count for weeks before it stopped.
export function mapContactedCount(rawContacted: unknown, rawLeads: unknown): number | null {
  if (typeof rawContacted !== 'number' || !Number.isFinite(rawContacted)) return null
  if (rawContacted < 0) return null
  if (typeof rawLeads === 'number' && Number.isFinite(rawLeads) && rawContacted > rawLeads) {
    logger.warn('Campaign analytics: contacted exceeds leads, refusing to write it as people', {
      contacted: rawContacted,
      leads: rawLeads,
      fix: 'Instantly changed the meaning of new_leads_contacted_count. Re-measure against FILTER_VAL_CONTACTED before trusting any field here.',
    })
    return null
  }
  return rawContacted
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
      sentCount:         r.emails_sent_count   ?? 0,
      repliedCount:      r.reply_count         ?? 0,
      bouncedCount:      r.bounced_count       ?? 0,
      // PEOPLE. new_leads_contacted_count, bounded by leads_count. Never contacted_count.
      contactedCount:    mapContactedCount(r.new_leads_contacted_count, r.leads_count),
      leadsCount:        typeof r.leads_count === 'number' ? r.leads_count : null,
      unsubscribedCount: r.unsubscribed_count  ?? 0,
      status:            mapCampaignStatus(r.campaign_status),
      rawStatus,
    })
  }

  return result
}
