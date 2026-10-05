// Switches a campaign on and sets its daily limit on the outbound provider.
//
// Implements CampaignControls (src/lib/outbound/regional-activation.ts), which the upload uses
// to activate a regional campaign when its first leads arrive. ADR-001: the provider's paths,
// its numeric status and its field names stop here.
//
// EVERY WRITE IS READ BACK. A 200 from the write is not taken as proof: each function reads the
// campaign again and throws unless the value it set is the value the provider now holds. A limit
// that did not land would otherwise be logged as changed, and the order that keeps the client
// under its cap (decreases before increases) would rest on a write nobody confirmed.
//
// Endpoints from the provider's OpenAPI, read 2026-10-05:
//   POST  /campaigns/{id}/activate   "Activate (start), or resume a campaign", no body
//   PATCH /campaigns/{id}            { daily_limit: number }
//   GET   /campaigns/{id}            status 1 = active; daily_limit (campaign-wide, see
//                                    thresholds.ts: it is NOT per mailbox, whatever the MCP says)

import { resolveInstantlyBaseUrl, shouldUseMockDispatch } from './constants'
import { getInstantlyApiKey, getInstantlyApiActive } from './auth'
import { InstantlyFlagError } from './types'
import type { CampaignControls } from '@/lib/outbound/regional-activation'

const PROVIDER_STATUS_ACTIVE = 1

async function access(organisationId: string) {
  const apiKey = await getInstantlyApiKey(organisationId)
  const isActive = await getInstantlyApiActive()
  const baseUrl = resolveInstantlyBaseUrl(isActive)
  if (!isActive && !shouldUseMockDispatch(isActive) && baseUrl.includes('api.instantly.ai')) {
    throw new InstantlyFlagError('campaign-controls: instantly_api_active is false — cannot call production Instantly')
  }
  return { apiKey, baseUrl, mock: shouldUseMockDispatch(isActive) }
}

async function call(a: { apiKey: string; baseUrl: string }, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${a.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${a.apiKey}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '(unreadable)')
    throw new Error(`${method} ${path.split('/').slice(0, 2).join('/')} returned HTTP ${res.status}: ${text.slice(0, 160)}`)
  }
  const json = await res.json().catch(() => null)
  return json && typeof json === 'object' ? json as Record<string, unknown> : {}
}

export function createCampaignControls(organisationId: string): CampaignControls {
  // Mock dispatch (staging) holds limits and states in memory for the life of this object, so a
  // staging upload exercises the same sequence without reaching a real provider.
  const mockLimits = new Map<string, number | null>()

  const read = async (externalId: string) => {
    const a = await access(organisationId)
    if (a.mock) return { status: PROVIDER_STATUS_ACTIVE, daily_limit: mockLimits.get(externalId) ?? null }
    return call(a, 'GET', `/campaigns/${encodeURIComponent(externalId)}`)
  }

  return {
    async readDailyLimit(externalId) {
      const c = await read(externalId)
      return typeof c.daily_limit === 'number' ? c.daily_limit : null
    },

    async setDailyLimit(externalId, limit) {
      const a = await access(organisationId)
      if (a.mock) { mockLimits.set(externalId, limit); return }
      await call(a, 'PATCH', `/campaigns/${encodeURIComponent(externalId)}`, { daily_limit: limit })
      const back = await read(externalId)
      if (back.daily_limit !== limit) {
        throw new Error(`daily limit read back as ${String(back.daily_limit)} after setting ${limit}`)
      }
    },

    async activate(externalId) {
      const a = await access(organisationId)
      if (a.mock) return
      await call(a, 'POST', `/campaigns/${encodeURIComponent(externalId)}/activate`)
      const back = await read(externalId)
      if (back.status !== PROVIDER_STATUS_ACTIVE) {
        throw new Error(`campaign read back with status ${String(back.status)} after activating, not ${PROVIDER_STATUS_ACTIVE} (active)`)
      }
    },
  }
}
