// Instantly implementation of WatchProvider.
//
// THE API BOUNDARY for the weekly watch. Endpoint paths, the Bearer header, the
// `next_starting_after` pagination quirk, the `status === 1` encoding of "active" and the
// omitted-when-zero `landed_spam` field all stop here. src/lib/weekly-watch/ sees the
// WatchProvider interface and nothing Instantly-shaped (ADR-001).
//
// READS ONLY. The single POST is /accounts/warmup-analytics, which Instantly exposes as a
// POST because it takes a mailbox list in the body. Nothing here modifies a campaign, an
// account or a daily limit.

import type { ProviderAccount, ProviderWarmup, WatchProvider } from '@/lib/weekly-watch/types'

export interface InstantlyWatchAccess {
  apiKey:  string
  baseUrl: string
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

async function call(access: InstantlyWatchAccess, path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${access.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${access.apiKey}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable body)')
    throw new Error(`${path} returned HTTP ${res.status}: ${body.slice(0, 160)}`)
  }
  const json: unknown = await res.json().catch(() => null)
  if (json === null) throw new Error(`${path} returned a body that was not valid JSON`)
  return json
}

function listOf(json: unknown): unknown[] {
  if (Array.isArray(json)) return json
  if (json && typeof json === 'object') {
    const o = json as Record<string, unknown>
    if (Array.isArray(o.result)) return o.result
    if (Array.isArray(o.items)) return o.items
  }
  throw new Error('expected an array, a { result: [] } or an { items: [] }')
}

export function createInstantlyWatchProvider(access: InstantlyWatchAccess): WatchProvider {
  return {
    async fetchWarmupPlacement(mailboxes) {
      const json = await call(access, '/accounts/warmup-analytics', {
        method: 'POST',
        body: JSON.stringify({ emails: mailboxes }),
      })
      const agg = json && typeof json === 'object' && 'aggregate_data' in json
        ? (json as { aggregate_data: unknown }).aggregate_data
        : null
      if (!agg || typeof agg !== 'object') throw new Error('warmup response carried no aggregate_data object')

      const out = new Map<string, ProviderWarmup>()
      for (const [mailbox, raw] of Object.entries(agg as Record<string, unknown>)) {
        if (!raw || typeof raw !== 'object') continue
        const e = raw as Record<string, unknown>
        const sent = num(e.sent)
        const landedInbox = num(e.landed_inbox)
        if (sent === null || landedInbox === null) continue

        // landed_spam is OMITTED when it is zero, so it is derived rather than assumed.
        // A mailbox whose sends do not add up then shows the shortfall instead of reading
        // clean, which is the whole reason this figure is worth collecting.
        const explicit = num(e.landed_spam)
        const derived  = sent - landedInbox
        out.set(mailbox.trim().toLowerCase(), {
          sent,
          landedInbox,
          landedSpam:  explicit ?? (derived >= 0 ? derived : 0),
          healthScore: num(e.health_score),
        })
      }
      return out
    },

    async fetchAccountStatuses() {
      const out = new Map<string, ProviderAccount>()
      let cursor: string | null = null
      // TERMINATES ON AN EMPTY PAGE, not an absent cursor: /accounts returns a cursor even
      // on the final page. Same quirk documented in the sending-health handler.
      for (let page = 0; page < 20; page++) {
        const qs = new URLSearchParams({ limit: '100' })
        if (cursor) qs.set('starting_after', cursor)
        const json = await call(access, `/accounts?${qs.toString()}`)
        const items = listOf(json) as Array<Record<string, unknown>>
        if (items.length === 0) break
        for (const it of items) {
          if (typeof it.email !== 'string') continue
          out.set(it.email.trim().toLowerCase(), {
            active:       it.status === 1,
            warmupActive: it.warmup_status === 1,
          })
        }
        const next = json && typeof json === 'object' && 'next_starting_after' in json
          ? (json as { next_starting_after?: unknown }).next_starting_after
          : null
        if (typeof next !== 'string' || next.length === 0) break
        cursor = next
      }
      return out
    },

    async fetchCampaignShape(externalId) {
      const json = await call(access, `/campaigns/${externalId}`)
      if (!json || typeof json !== 'object') throw new Error('campaign response was not an object')
      const c = json as Record<string, unknown>
      const dailyLimit = num(c.daily_limit)
      if (dailyLimit === null) throw new Error('campaign carried no numeric daily_limit')
      const senders = Array.isArray(c.email_list)
        ? c.email_list.filter((e): e is string => typeof e === 'string')
        : []
      if (senders.length === 0) throw new Error('campaign carried an empty email_list')
      return { dailyLimit, senders }
    },

    async fetchPlanId() {
      const json = await call(access, '/workspaces/current')
      if (!json || typeof json !== 'object') throw new Error('workspace response was not an object')
      const planId = (json as Record<string, unknown>).plan_id
      if (typeof planId !== 'string' || planId.length === 0) throw new Error('workspace carried no plan_id')
      return planId
    },

    async fetchCampaignLeadCounts() {
      const rows = listOf(await call(access, '/campaigns/analytics')) as Array<Record<string, unknown>>
      return rows.map(r => {
        const n = num(r.leads_count)
        if (n === null) throw new Error('a campaign analytics row carried no numeric leads_count')
        return n
      })
    },
  }
}
