// The four client-facing metric reads, and what happens when one of them does not answer.
//
// THE FAILURE THIS GUARDS. postgrest-js converts a refusal, a network failure and a
// timeout alike into { data: null, error }. It never throws. So `?? []` and `?? 0` turned
// all three into the same confident zero, and a client whose campaign is running could be
// shown a dashboard saying nothing had happened, with nothing anywhere recording that a
// read had failed. The numbers still degrade, because a page that renders beats a page
// that does not, but the failure now writes a row.

import { describe, it, expect, beforeEach, vi } from 'vitest'

const recorded: Array<Record<string, unknown>> = []
vi.mock('@/lib/dashboard/record-dashboard-failure', () => ({
  recordDashboardFailure: async (f: Record<string, unknown>) => { recorded.push(f) },
}))

/** Result per relation, in the order the chokepoint queries them. */
let byRelation: Record<string, { data: unknown; count: number | null; error: { message: string } | null }> = {}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (relation: string) => {
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'not']) chain[m] = () => chain
      chain.then = (onFulfilled: (v: unknown) => unknown) =>
        Promise.resolve(
          byRelation[relation] ?? { data: [], count: 0, error: null },
        ).then(onFulfilled)
      return new Proxy(chain, {
        get(t, p: string) {
          if (p in t) return t[p]
          throw new Error(`fake supabase: .${p}() is not implemented and was not honoured`)
        },
      })
    },
  }),
  SupabaseClient: class {},
}))

import { getClientVisibleCampaignMetrics } from '@/lib/metrics/get-client-visible-campaign-metrics'

beforeEach(() => {
  recorded.length = 0
  byRelation = {}
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
})

describe('getClientVisibleCampaignMetrics failure recording', () => {
  it('writes nothing when every read answers', async () => {
    await getClientVisibleCampaignMetrics('org-1')
    expect(recorded).toEqual([])
  })

  it('records the campaigns read failing, and still returns a renderable shape', async () => {
    byRelation.campaigns = { data: null, count: null, error: { message: 'permission denied' } }
    const metrics = await getClientVisibleCampaignMetrics('org-1')

    expect(metrics.sentCount, 'the page must still render').toBe(0)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({
      kind: 'read',
      source: 'client-visible-campaign-metrics:campaigns',
      organisationId: 'org-1',
      route: '/dashboard',
    })
  })

  it('records EVERY failed read, not just the first', async () => {
    // Four reads run in one Promise.all. Reporting only the first would understate an
    // outage as a single-card problem.
    byRelation.campaigns = { data: null, count: null, error: { message: 'a' } }
    byRelation.meetings = { data: null, count: null, error: { message: 'b' } }
    byRelation.signals = { data: null, count: null, error: { message: 'c' } }
    await getClientVisibleCampaignMetrics('org-1')
    expect(recorded.map(r => r.source).sort()).toEqual([
      'client-visible-campaign-metrics:campaigns',
      'client-visible-campaign-metrics:meetings',
      'client-visible-campaign-metrics:reply-signals',
    ])
  })

  it('scopes every failure row to the organisation that was being read', async () => {
    byRelation.reply_handling_actions = { data: null, count: null, error: { message: 'x' } }
    await getClientVisibleCampaignMetrics('org-42')
    expect(recorded[0].organisationId).toBe('org-42')
  })
})
