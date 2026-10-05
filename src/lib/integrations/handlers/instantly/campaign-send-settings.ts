// Reads a campaign's send window, daily limit and mailbox count from the outbound provider.
//
// THE PROVIDER IS THE SOURCE OF TRUTH for when a campaign sends: it is what enforces the
// window. We do not keep a second copy in campaigns (see 20261005200000_campaign_regions.sql),
// so the upload panel reads it from here and shows each regional campaign's real schedule.
//
// READ ONLY. One GET /campaigns/{id}. ADR-001: the provider's field names and its time-zone
// vocabulary stop at this file; callers get CampaignSendSettings in canonical IANA names.

import { resolveInstantlyBaseUrl, shouldUseMockDispatch } from './constants'
import { getInstantlyApiKey, getInstantlyApiActive } from './auth'
import { mockCampaignGet } from './mock-dispatch'
import { InstantlyFlagError } from './types'
import type { CampaignSendSettings, CampaignSendWindow } from '@/lib/outbound/campaign-region-text'

export type { CampaignSendSettings, CampaignSendWindow }

// ─── The provider's time zones, translated to canonical ──────────────────────
//
// The provider accepts only a fixed list of ~100 zones, and Europe/London is NOT on it
// (measured 2026-10-05: POST /campaigns refused it, "must be equal to one of the allowed
// values"). Europe/Isle_of_Man is, and in the IANA database it is a link to Europe/London:
// same GMT/BST offsets, same change dates (checked across both 2026 transitions). So a UK
// window is stored on the provider as Isle_of_Man and shown to the operator as London.
// Europe/Dublin keeps the same clock, so it serves IE as well.
const PROVIDER_ZONE_TO_CANONICAL: Readonly<Record<string, string>> = {
  'Europe/Isle_of_Man': 'Europe/London',
}

export function canonicalZone(providerZone: string): string {
  return PROVIDER_ZONE_TO_CANONICAL[providerZone] ?? providerZone
}

/** Pure: the provider's campaign object to canonical settings. Exported for tests. */
export function parseCampaignSendSettings(data: Record<string, unknown>): CampaignSendSettings {
  const schedule = data.campaign_schedule as { schedules?: unknown } | undefined
  const raw = Array.isArray(schedule?.schedules) ? schedule!.schedules as Array<Record<string, unknown>> : []

  const windows: CampaignSendWindow[] = raw.map(s => {
    const timing = (s.timing ?? {}) as { from?: unknown; to?: unknown }
    const days = Object.entries((s.days ?? {}) as Record<string, unknown>)
      .filter(([, on]) => on === true)
      .map(([d]) => Number(d))
      .filter(d => Number.isInteger(d) && d >= 0 && d <= 6)
      .sort((a, b) => a - b)
    return {
      timezone: canonicalZone(typeof s.timezone === 'string' ? s.timezone : '(no time zone)'),
      from: typeof timing.from === 'string' ? timing.from : '?',
      to: typeof timing.to === 'string' ? timing.to : '?',
      days,
    }
  })

  return {
    windows,
    dailyLimit: typeof data.daily_limit === 'number' && Number.isFinite(data.daily_limit) ? data.daily_limit : null,
    senderCount: Array.isArray(data.email_list) ? data.email_list.length : 0,
  }
}

export async function readCampaignSendSettings(
  organisationId: string,
  campaignExternalId: string,
): Promise<CampaignSendSettings> {
  const apiKey = await getInstantlyApiKey(organisationId)
  const isActive = await getInstantlyApiActive()
  const baseUrl = resolveInstantlyBaseUrl(isActive)

  if (!isActive && !shouldUseMockDispatch(isActive) && baseUrl.includes('api.instantly.ai')) {
    throw new InstantlyFlagError('readCampaignSendSettings: instantly_api_active is false — cannot call production Instantly')
  }

  const response = shouldUseMockDispatch(isActive)
    ? mockCampaignGet(campaignExternalId)
    : await fetch(`${baseUrl}/campaigns/${encodeURIComponent(campaignExternalId)}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      })

  if (!response.ok) {
    const body = await response.text().catch(() => '(unreadable)')
    throw new Error(`campaign read returned HTTP ${response.status}: ${body.slice(0, 160)}`)
  }
  const data = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!data || typeof data !== 'object') throw new Error('campaign read returned a body that was not a JSON object')
  return parseCampaignSendSettings(data)
}
