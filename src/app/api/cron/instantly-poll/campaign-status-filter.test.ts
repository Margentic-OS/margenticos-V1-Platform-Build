// The campaign stats refresh must NOT filter on campaigns.status.
//
// This is a guard on the ABSENCE of a filter, which is why it needs its own file.
//
// The refresh once read `.eq('status', 'active')`, and that gated the loop on the very
// column the loop is responsible for maintaining: the creation insert hardcodes 'draft',
// nothing else moved it, so a campaign stuck at 'draft' could never be freed by any number
// of ticks. Removing the filter is what made the dashboard panel fill. See the header of
// campaign-stats.test.ts for the full 2026-08-21 finding.
//
// campaign-stats.test.ts already has a case named
//   'no longer filters on status, so every campaign with an external_id is refreshed'
// but it cannot see filters. Its stand-in returns `builder` from .eq() and then hands back
// db.campaigns whole, so re-adding .eq('status','active') to the route leaves it green.
// Measured 2026-09-07 against 1be5f00: with the filter re-added, all 55 tests in
// src/app/api/cron/instantly-poll passed, that one included.
//
// The stand-in here honours .eq/.not/.is against the seeded rows AND records them, so the
// regression is caught two independent ways: the row set shrinks, and the recorded filter
// list gains a status entry. A positive control below proves the recorder can see a filter
// that IS expected, so the absence assertion cannot pass merely because recording is broken.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('@sentry/nextjs', () => ({
  captureCheckIn: vi.fn(() => 'mock-checkin-id'),
  captureException: vi.fn(),
  flush: vi.fn(() => Promise.resolve()),
}))

interface CampaignRow {
  id: string
  organisation_id: string
  external_id: string
  status: string
  sending_state?: string | null
}

/** One recorded read of the campaigns table: what it selected and what it filtered on. */
interface CampaignQuery {
  select: string
  filters: Array<{ op: string; column: string; value: unknown }>
}

const db = vi.hoisted(() => ({
  campaigns: [] as Array<{
    id: string
    organisation_id: string
    external_id: string
    status: string
    sending_state?: string | null
  }>,
  // Organisations the inner join resolves against. The reply poll in the same route reads
  // campaigns through organisations!inner, so every seeded campaign needs a live parent or
  // it would be dropped for a reason that has nothing to do with this file's subject.
  organisations: {} as Record<string, { archived_at: string | null }>,
  campaignQueries: [] as CampaignQuery[],
  campaignUpdates: [] as Array<{ id: string; payload: Record<string, unknown> }>,
}))

vi.mock('@supabase/supabase-js', () => ({
  /* eslint-disable @typescript-eslint/no-explicit-any */
  createClient: () => ({
    from(table: string) {
      if (table === 'campaigns') {
        const query: CampaignQuery = { select: '', filters: [] }
        const joins: string[] = []
        const predicates: Array<(row: CampaignRow) => boolean> = []

        function columnValue(column: string, row: CampaignRow): unknown {
          if (!column.includes('.')) return (row as unknown as Record<string, unknown>)[column]
          const [resource, field] = column.split('.')
          if (!joins.includes(resource)) {
            throw new Error(
              `fake: filter on "${column}" but select() never joined "${resource}"`,
            )
          }
          const joined = db.organisations[row.organisation_id]
          if (!joined) return undefined
          return (joined as unknown as Record<string, unknown>)[field]
        }

        const builder: any = {
          select(cols: string) {
            query.select = cols
            for (const match of cols.matchAll(/(\w+)!inner\s*\(/g)) {
              joins.push(match[1])
              predicates.push(row => Boolean(db.organisations[row.organisation_id]))
            }
            return builder
          },
          eq(column: string, value: unknown) {
            query.filters.push({ op: 'eq', column, value })
            predicates.push(row => String(columnValue(column, row)) === String(value))
            return builder
          },
          not(column: string, op: string, value: unknown) {
            if (op !== 'is' || value !== null) {
              throw new Error(`fake: .not(${column}, ${op}, ${String(value)}) is not implemented`)
            }
            query.filters.push({ op: 'not.is', column, value })
            predicates.push(row => {
              const actual = columnValue(column, row)
              return actual !== null && actual !== undefined
            })
            return builder
          },
          is(column: string, value: unknown) {
            if (value !== null) {
              throw new Error(`fake: .is(${column}, ${String(value)}) is not implemented`)
            }
            query.filters.push({ op: 'is', column, value })
            predicates.push(row => {
              const actual = columnValue(column, row)
              return actual === null || actual === undefined
            })
            return builder
          },
          in() { throw new Error('fake: .in() on campaigns is not implemented') },
          or() { throw new Error('fake: .or() on campaigns is not implemented') },
          limit() { throw new Error('fake: .limit() on campaigns is not implemented') },
          update: (payload: Record<string, unknown>) => ({
            eq: async (_col: string, id: string) => {
              db.campaignUpdates.push({ id, payload })
              return { error: null }
            },
          }),
          then: (settle: (v: unknown) => unknown) => {
            db.campaignQueries.push(query)
            return settle({
              data: db.campaigns.filter(row => predicates.every(p => p(row))),
              error: null,
            })
          },
        }
        return builder
      }

      if (table === 'polling_cursors') {
        const builder: any = {
          select: () => builder,
          is: () => builder,
          eq: () => builder,
          maybeSingle: async () => ({ data: { last_cursor: null, error_count: 0 }, error: null }),
          upsert: async () => ({ error: null }),
        }
        return builder
      }
      if (table === 'signals') {
        return { insert: () => ({ select: async () => ({ data: [{ id: 'sig-1' }], error: null }) }) }
      }
      if (table === 'suppressed_emails') {
        return { insert: async () => ({ error: null }) }
      }
      if (table === 'cron_heartbeats') {
        return { insert: () => ({ throwOnError: async () => ({ error: null }) }) }
      }
      if (table === 'integrations_registry') {
        const builder: any = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => ({ data: null, error: null }),
        }
        return builder
      }
      if (table === 'sending_mailbox_daily_stats') {
        const builder: any = {
          select: () => builder,
          gte: () => builder,
          lte: () => Promise.resolve({ data: [], error: null }),
          upsert: async () => ({ error: null }),
        }
        return builder
      }
      if (table === 'sending_health_snapshot') {
        return { upsert: async () => ({ error: null }) }
      }
      if (table === 'reply_reconciliation_snapshot') {
        return { upsert: async () => ({ error: null }) }
      }
      if (table === 'unattributed_replies') {
        const q: any = {
          delete: () => q,
          update: () => q,
          select: async () => ({ data: [], error: null }),
          lt: () => q,
          is: () => q,
          eq: () => q,
        }
        return q
      }

      throw new Error(`fake supabase: unexpected table ${table}`)
    },
  }),
  /* eslint-enable @typescript-eslint/no-explicit-any */
}))

import { POST } from './route'

const CRON_SECRET = 'test-secret-12345'
const ORG = 'org-a'
const EXT_ONE = 'cf695496-dba1-4bcb-beae-1b6ca28209d6'
const EXT_TWO = '2b0f6a71-7d54-4a1e-9f0c-1d2e3f4a5b6c'

function cronRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/cron/instantly-poll', {
    method: 'POST',
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function analyticsRow(campaignId: string, overrides: Record<string, unknown> = {}) {
  return {
    campaign_name: 'A sequence',
    campaign_id: campaignId,
    campaign_status: 1,
    emails_sent_count: 15,
    reply_count: 0,
    bounced_count: 0,
    leads_count: 15,
    new_leads_contacted_count: 15,
    unsubscribed_count: 0,
    ...overrides,
  }
}

function stubFetch(rows: unknown[]) {
  return vi.fn(async (url: string | URL) => {
    const u = String(url)
    if (u.includes('/campaigns/analytics')) return jsonResponse(rows)
    if (u.includes('/emails')) return jsonResponse({ items: [] })
    return jsonResponse({ items: [] })
  })
}

function campaign(id: string, external_id: string, status: string): CampaignRow {
  return { id, organisation_id: ORG, external_id, status, sending_state: null }
}

/**
 * The stats refresh read, identified by its select string. The reply poll reads the same
 * table through an inner join, so picking by "no embedded resource" separates the two
 * without depending on the order the route happens to run them in.
 */
function statsRead(): CampaignQuery {
  const reads = db.campaignQueries.filter(q => !q.select.includes('!inner'))
  expect(reads).toHaveLength(1)
  return reads[0]
}

beforeEach(() => {
  vi.clearAllMocks()
  db.campaignQueries.length = 0
  db.campaignUpdates.length = 0
  db.organisations = { [ORG]: { archived_at: null } }
  db.campaigns = [campaign('internal-a', EXT_ONE, 'draft')]
  process.env.CRON_SECRET = CRON_SECRET
  process.env.INSTANTLY_API_ACTIVE = 'true'
  process.env.INSTANTLY_API_KEY_OVERRIDE = 'test-key'
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'
  delete process.env.INSTANTLY_API_BASE_URL
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.INSTANTLY_API_ACTIVE
  delete process.env.INSTANTLY_API_KEY_OVERRIDE
})

describe('the campaign stats refresh does not filter on status', () => {
  // THE POSITIVE CONTROL, and it comes first on purpose. The absence assertion below is only
  // worth anything if this recorder can see a filter that IS there.
  it('records the external_id filter the read genuinely applies', async () => {
    vi.stubGlobal('fetch', stubFetch([analyticsRow(EXT_ONE)]))

    await POST(cronRequest())

    expect(statsRead().filters).toContainEqual({
      op: 'not.is',
      column: 'external_id',
      value: null,
    })
  })

  // THE GUARD, stated directly against the query.
  it('applies no filter on status at all', async () => {
    vi.stubGlobal('fetch', stubFetch([analyticsRow(EXT_ONE)]))

    await POST(cronRequest())

    const statusFilters = statsRead().filters.filter(f => f.column === 'status')
    expect(statusFilters).toEqual([])
  })

  // THE GUARD AGAIN, stated as behaviour rather than as query shape. These two fail for the
  // same regression by different routes, so neither is load-bearing alone.
  it('refreshes a campaign whose local status is still the hardcoded draft', async () => {
    db.campaigns = [campaign('internal-a', EXT_ONE, 'draft')]
    vi.stubGlobal('fetch', stubFetch([analyticsRow(EXT_ONE)]))

    await POST(cronRequest())

    expect(db.campaignUpdates.map(u => u.id)).toEqual(['internal-a'])
    expect(db.campaignUpdates[0].payload.status).toBe('active')
  })

  it('refreshes campaigns sitting in local statuses the old filter excluded', async () => {
    db.campaigns = [
      campaign('internal-a', EXT_ONE, 'draft'),
      campaign('internal-b', EXT_TWO, 'completed'),
    ]
    vi.stubGlobal('fetch', stubFetch([
      analyticsRow(EXT_ONE),
      analyticsRow(EXT_TWO, { campaign_status: 2, emails_sent_count: 7 }),
    ]))

    await POST(cronRequest())

    expect(db.campaignUpdates.map(u => u.id).sort()).toEqual(['internal-a', 'internal-b'])
    const byId = Object.fromEntries(db.campaignUpdates.map(u => [u.id, u.payload]))
    expect(byId['internal-a'].status).toBe('active')
    expect(byId['internal-b'].status).toBe('paused')
    expect(byId['internal-b'].sent_count).toBe(7)
  })
})
