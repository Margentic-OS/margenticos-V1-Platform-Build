// src/lib/integrations/handlers/instantly/campaign-sending-status.ts
//
// Answers the one question campaigns.status cannot: is this campaign actually sending
// mail right now.
//
// campaign-analytics.ts copies Instantly's campaign_status into our four-value column.
// That value is INTENT. A campaign at 'active' can be sending nothing at all, and the
// dashboard has no way to tell from that column alone. This file reads
// GET /campaigns/{id}/sending-status, where 'healthy' is the only value that means mail
// is leaving, and translates the answer into our own vocabulary.
//
// This file is the API boundary. Instantly's eighteen status strings stop here. Nothing
// above the integrations layer sees one, per the tool-agnostic rule in CLAUDE.md.

import { logger } from '@/lib/logger'
import { shouldUseMockDispatch } from './constants'
import { mockCampaignSendingStatus } from './mock-dispatch'
import { InstantlyFlagError } from './types'

// ── Our vocabulary ────────────────────────────────────────────────────────────
//
// Seven values, mirrored by campaigns_sending_state_check in
// supabase/migrations/20260824140000_campaign_sending_state.sql. Change one, change both
// in the same commit.
//
// Only 'sending' means mail is going out. Every other value means it is not, and the
// difference between them is WHY, in terms a client-facing surface can render without
// quoting Instantly.
export type CampaignSendingState =
  | 'sending'        // mail is leaving right now
  | 'draft'          // never started
  | 'paused'         // deliberately stopped
  | 'completed'      // finished its sequence
  | 'waiting'        // intends to send, has nothing to send this moment
  | 'limit_reached'  // intends to send, has hit a cap for today
  | 'blocked'        // stopped by Instantly, not by us. The one an operator must see.

export interface CampaignSendingStatusResult {
  // null means Instantly answered but carried no status. Documented behaviour, not a
  // failure: the endpoint returns null for both fields when it has no data for the
  // campaign yet. Callers must clear the stored state rather than leave a stale one.
  state:     CampaignSendingState | null
  // The raw Instantly code, kept so a caller can name it in a log or store it for
  // diagnostics without reaching back into Instantly's vocabulary itself.
  rawStatus: string | null
}

// ── Instantly's sending-status enum, verified 2026-08-24 ──────────────────────
//
// Source of truth: the official OpenAPI document at
// https://developer.instantly.ai/api-reference/openapi.json, at
// paths./api/v2/campaigns/{id}/sending-status.get, response 200,
// properties.diagnostics.properties.status. Declared as a closed enum of EIGHTEEN
// strings. Verified against the spec directly, not from the Instantly MCP tool
// description and not from memory.
//
// THIS IS NOT not_sending_status, AND THE DIFFERENCE MATTERS. The campaign object
// (components.schemas.def-1) carries a separate not_sending_status, a five-value NUMERIC
// enum: 1 out of schedule, 2 waiting for leads, 3 daily limit met, 4 all accounts at
// daily limit, 99 error. Both were verified in the same pass. Mapping this endpoint's
// response through that five-code vocabulary would silently discard thirteen values,
// including every campaign-state code and every account-health code. The endpoint is
// strictly richer, so it is the only source used here.
const INSTANTLY_SENDING_STATUS: Readonly<Record<string, CampaignSendingState>> = {
  // The only unobstructed value in the enum.
  healthy: 'sending',

  // Campaign-state codes. These duplicate what campaign_status already tells us, and
  // they are mapped anyway so that a single column can be read for "is it sending"
  // without a second lookup and without the two columns being able to disagree.
  campaign_draft:     'draft',
  campaign_paused:    'paused',
  campaign_completed: 'completed',

  // Nothing to send at this instant, but the campaign intends to send.
  //
  // campaign_running_subsequences sits here, while campaign-analytics.ts maps the numeric
  // status 4 to 'active'. That is deliberate and not a contradiction: intent is active,
  // health is not healthy. BACKLOG.md flagged status 4 as a judgement call made on
  // ambiguous documentation. This endpoint settles it, because it lists the code among
  // the reasons a campaign is not sending and treats 'healthy' as the sole unobstructed
  // value. The primary sequence is not sending; the campaign is still working.
  out_of_schedule:               'waiting',
  waiting_for_leads:             'waiting',
  follow_up_delay_not_met:       'waiting',
  waiting_for_esp_match:         'waiting',
  campaign_running_subsequences: 'waiting',

  // A cap has been hit for today. Sending resumes without anyone doing anything.
  daily_limit_met:         'limit_reached',
  account_daily_limit_met: 'limit_reached',
  new_lead_limit_met:      'limit_reached',
  domain_limit_reached:    'limit_reached',

  // Stopped by Instantly, against our wishes. Nothing resumes on its own here; every one
  // of these needs a human. This is the bucket campaigns.status cannot express at all,
  // because all three of its abnormal stops collapse onto plain 'paused'.
  campaign_bounce_protect:     'blocked',
  campaign_accounts_unhealthy: 'blocked',
  campaign_account_suspended:  'blocked',
  all_accounts_unhealthy:      'blocked',
  no_accounts_available:       'blocked',
}

// Codes that mean a human has to act. Callers use this to decide whether to log loudly:
// 'waiting' and 'limit_reached' clear themselves, 'blocked' does not.
export const SENDING_STATES_NEEDING_ATTENTION: readonly CampaignSendingState[] = ['blocked']

// Maps Instantly's sending-status string onto our vocabulary.
//
// Returns null for anything outside the documented enum, and for any non-string. No
// coercion and no default, for the same reason mapCampaignStatus has none: an
// unrecognised value means Instantly changed a closed enum, which is a schema change
// worth seeing. Defaulting it to 'sending' would print the word live on a client's
// dashboard on the strength of a value we did not understand.
export function mapSendingStatus(raw: unknown): CampaignSendingState | null {
  if (typeof raw !== 'string') return null
  return INSTANTLY_SENDING_STATUS[raw] ?? null
}

// Response shape (subset). Both top-level fields are nullable by contract: the endpoint
// "returns null for both fields if no data is available". Fields inside diagnostics other
// than campaign_id, last_updated, status and issue_tracking may be absent when the
// campaign is out of schedule, so nothing here may assume they exist.
interface InstantlySendingStatusResponse {
  diagnostics: { status?: unknown } | null
  summary:     { status?: unknown } | null
}

// fetchCampaignSendingStatus — reads live sending health for ONE campaign.
//
// One call per campaign, unlike the workspace-wide analytics call, because Instantly
// offers no bulk form of this endpoint. Callers should only ask for campaigns they
// already know exist in Instantly, so a row pointing at a deleted campaign fails once in
// the analytics pass rather than twice.
//
// Throws on network error or non-2xx so the caller can count the failure. A campaign
// whose health we could not read must never be reported as sending.
export async function fetchCampaignSendingStatus(
  externalId: string,
  apiKey: string,
  isActive: boolean,
  baseUrl: string,
): Promise<CampaignSendingStatusResult> {
  // Same safety gate as fetchCampaignStats: flag off while the base URL points at
  // production is a misconfiguration, not a mock run.
  if (!isActive && !shouldUseMockDispatch(isActive) && baseUrl.includes('api.instantly.ai')) {
    throw new InstantlyFlagError(
      'fetchCampaignSendingStatus: instantly_api_active is false — cannot call production Instantly'
    )
  }

  let response: Response
  if (shouldUseMockDispatch(isActive)) {
    response = mockCampaignSendingStatus()
  } else {
    try {
      response = await fetch(`${baseUrl}/campaigns/${encodeURIComponent(externalId)}/sending-status`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      })
    } catch (err) {
      throw new Error(`Campaign sending-status network error: ${String(err)}`)
    }
  }

  if (response.status === 429) {
    throw new Error('Campaign sending-status rate limited (429) — caller should surface to operator')
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '(unreadable)')
    throw new Error(`Campaign sending-status API error ${response.status}: ${body.slice(0, 200)}`)
  }

  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    throw new Error('Campaign sending-status response was not valid JSON')
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Campaign sending-status response was not an object')
  }

  const body = parsed as InstantlySendingStatusResponse

  // diagnostics.status is the always-present field per the endpoint's own description.
  // summary.status carries the same code and is read only as a fallback, so a response
  // that omits diagnostics but carries a summary is still usable.
  const rawFromDiagnostics = body.diagnostics?.status
  const rawFromSummary     = body.summary?.status
  const raw = typeof rawFromDiagnostics === 'string' ? rawFromDiagnostics
            : typeof rawFromSummary     === 'string' ? rawFromSummary
            : null

  const state = mapSendingStatus(raw)

  // A string we do not recognise is a changed enum. Say so; do not guess a state.
  if (raw !== null && state === null) {
    logger.warn('Campaign sending-status: unrecognised status code, state left unestablished', {
      external_id: externalId,
      raw_status: raw,
      fix: 'Check the sending-status enum in campaign-sending-status.ts against Instantly OpenAPI paths./api/v2/campaigns/{id}/sending-status',
    })
  }

  return { state, rawStatus: raw }
}
