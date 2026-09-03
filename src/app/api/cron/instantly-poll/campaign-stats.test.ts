// Tests for the campaign stats and status refresh inside the instantly-poll route.
//
// Two independent defects were confirmed live on 2026-08-21, and fixing either alone
// left the dashboard panel empty:
//
//   A. Nothing wrote campaigns.status. The creation insert hardcodes 'draft' and no
//      code path ever moved it. The refresh then filtered on .eq('status','active'),
//      which excluded the one real campaign before the lookup could correct it. That
//      filter gated the loop on the column the loop is responsible for maintaining, so
//      a campaign stuck at 'draft' could never be freed by any number of ticks.
//   B. Campaigns whose external_id is not a real Instantly campaign missed the lookup
//      and were counted as a silent skip, so campaign_stats_updated_at stayed null even
//      for rows the filter did not exclude.
//
// These drive the REAL POST handler. The only substitutions are the process boundaries
// a test cannot reach: the Supabase client, Sentry, and global fetch. Every assertion is
// on the payload the production code actually sent to the database.
//
// The status enum under test is the verified one from Instantly's OpenAPI document,
// components.schemas.def-1.properties.status: a closed enum of eight values
// [-99, -1, -2, 0, 1, 2, 3, 4]. The Instantly MCP tool description documents only 0-3,
// so a mapping derived from it would silently drop four states. These tests pin all eight.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

const sentry = vi.hoisted(() => ({
  captureCheckIn: vi.fn(
    (_checkIn: { monitorSlug: string; status: string; checkInId?: string }, _config?: unknown) =>
      'mock-checkin-id'
  ),
  captureException: vi.fn((_err: Error, _ctx?: unknown) => undefined),
  flush: vi.fn(() => Promise.resolve()),
}))
vi.mock('@sentry/nextjs', () => sentry)

interface CampaignRow {
  id: string
  organisation_id: string
  external_id: string
  status: string
}

// Captures every row the route writes.
const db = vi.hoisted(() => ({
  sendingHealthTool: null as null | { tool_name: string; is_active: boolean },
  heartbeats: [] as Record<string, unknown>[],
  campaigns: [] as Array<{ id: string; organisation_id: string; external_id: string; status: string }>,
  campaignUpdates: [] as Array<{ id: string; payload: Record<string, unknown> }>,
  campaignUpdateError: null as { message: string } | null,
}))

vi.mock('@supabase/supabase-js', () => ({
  /* eslint-disable @typescript-eslint/no-explicit-any */
  createClient: () => ({
    from(table: string) {
      if (table === 'campaigns') {
        const builder: any = {
          select: () => builder,
          not: () => builder,
          is: () => builder,
          eq: () => builder,
          update: (payload: Record<string, unknown>) => ({
            eq: async (_col: string, id: string) => {
              db.campaignUpdates.push({ id, payload })
              return { error: db.campaignUpdateError }
            },
          }),
          then: (resolve: (v: unknown) => unknown) => resolve({ data: db.campaigns, error: null }),
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
        return {
          insert: (row: Record<string, unknown>) => {
            db.heartbeats.push(row)
            return { throwOnError: async () => ({ error: null }) }
          },
        }
      }
      // ── Sending health (MON-023) ────────────────────────────────────────
      // The route reads the capability registry and, when a tool is registered, writes
      // these two tables. Default here is NO tool registered, which makes the sync an
      // explicit no-op and leaves these tests measuring what they were written to measure.
      // db.sendingHealthTool flips it on for the test that asserts a sending-health
      // failure drags ok to false.
      if (table === 'integrations_registry') {
        const builder: any = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => ({ data: db.sendingHealthTool, error: null }),
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
      throw new Error(`fake supabase: unexpected table ${table}`)
    },
  }),
  /* eslint-enable @typescript-eslint/no-explicit-any */
}))

import { POST } from './route'
import { mapCampaignStatus } from '@/lib/integrations/handlers/instantly/campaign-analytics'

const CRON_SECRET = 'test-secret-12345'
const EXT = 'cf695496-dba1-4bcb-beae-1b6ca28209d6'

function cronRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/cron/instantly-poll', {
    method: 'POST',
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// One analytics row shaped like the live response, which was captured from the real
// workspace on 2026-08-23 and carries campaign_status alongside the counters.
function analyticsRow(overrides: Record<string, unknown> = {}) {
  return {
    campaign_name: 'Sequence one',
    campaign_id: EXT,
    campaign_status: 1,
    emails_sent_count: 15,
    reply_count: 0,
    bounced_count: 0,
    // People. contacted_count is deliberately NOT here: it is the field the handler must
    // ignore, so a fixture carrying it would let a revert keep passing.
    leads_count: 15,
    new_leads_contacted_count: 15,
    unsubscribed_count: 0,
    ...overrides,
  }
}

// Routes the three poller calls to empty results and serves analytics from `rows`.
// Returns only what the route asked for, so nothing here can accidentally satisfy an
// assertion the production code did not earn.
function stubFetch(rows: unknown[]) {
  return vi.fn(async (url: string | URL) => {
    const u = String(url)
    if (u.includes('/campaigns/analytics')) return jsonResponse(rows)
    if (u.includes('/emails')) return jsonResponse({ items: [] })
    return jsonResponse({ items: [] })
  })
}

function localCampaign(status: string, external_id: string = EXT): CampaignRow {
  return { id: 'internal-a', organisation_id: 'org-a', external_id, status }
}

// The single campaigns update the route made.
function onlyUpdate() {
  expect(db.campaignUpdates).toHaveLength(1)
  return db.campaignUpdates[0]
}

beforeEach(() => {
  vi.clearAllMocks()
  db.heartbeats.length = 0
  db.campaignUpdates.length = 0
  db.campaignUpdateError = null
  db.campaigns = [localCampaign('draft')]
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

// ── The enum itself ───────────────────────────────────────────────────────────

describe('mapCampaignStatus — the verified Instantly enum', () => {
  // Pinned from https://developer.instantly.ai/api-reference/openapi.json,
  // components.schemas.def-1.properties.status x-enumDescriptions.
  it.each([
    [0, 'draft', 'Draft'],
    [1, 'active', 'Active'],
    [2, 'paused', 'Paused'],
    [3, 'completed', 'Completed'],
    [4, 'active', 'Running Subsequences'],
    [-1, 'paused', 'Accounts Unhealthy'],
    [-2, 'paused', 'Bounce Protect'],
    [-99, 'paused', 'Account Suspended'],
  ])('maps %i (%s) to %s', (raw, expected) => {
    expect(mapCampaignStatus(raw)).toBe(expected)
  })

  it('covers all eight documented values and nothing else', () => {
    const documented = [-99, -1, -2, 0, 1, 2, 3, 4]
    for (const v of documented) expect(mapCampaignStatus(v)).not.toBeNull()
    // Values outside the closed enum are unmapped, not defaulted.
    for (const v of [5, 6, 99, -3, -98, -100]) expect(mapCampaignStatus(v)).toBeNull()
  })

  it('does NOT coerce a numeric string, so a type change is visible rather than papered over', () => {
    expect(mapCampaignStatus('1')).toBeNull()
    expect(mapCampaignStatus(null)).toBeNull()
    expect(mapCampaignStatus(undefined)).toBeNull()
  })
})

// ── Problem A: status syncs from Instantly ────────────────────────────────────

describe('campaigns.status syncs from Instantly, which is the source of truth', () => {
  it('an Instantly-active campaign that is locally draft syncs to active AND gets its stats', async () => {
    // The exact live case: cf695496 was 'draft' locally while Instantly reported status 1.
    // Under the old code .eq('status','active') excluded it before the lookup, forever.
    vi.stubGlobal('fetch', stubFetch([analyticsRow()]))

    const response = await POST(cronRequest())
    const body = await response.json()

    const { id, payload } = onlyUpdate()
    expect(id).toBe('internal-a')
    expect(payload.status).toBe('active')
    expect(payload.sent_count).toBe(15)
    expect(payload.replied_count).toBe(0)
    expect(payload.bounced_count).toBe(0)
    expect(typeof payload.campaign_stats_updated_at).toBe('string')

    expect(body.campaign_stats.updated).toBe(1)
    expect(body.campaign_stats.statusChanged).toBe(1)
  })

  it('stats are written for a previously-draft campaign, which the old filter made impossible', async () => {
    vi.stubGlobal('fetch', stubFetch([analyticsRow({ emails_sent_count: 42, reply_count: 3 })]))

    await POST(cronRequest())

    const { payload } = onlyUpdate()
    expect(payload.sent_count).toBe(42)
    expect(payload.replied_count).toBe(3)
    // The whole point: a draft row reached the update at all.
    expect(payload.status).toBe('active')
  })

  it('a paused Instantly campaign syncs to paused', async () => {
    db.campaigns = [localCampaign('active')]
    vi.stubGlobal('fetch', stubFetch([analyticsRow({ campaign_status: 2 })]))

    await POST(cronRequest())

    expect(onlyUpdate().payload.status).toBe('paused')
  })

  it('a completed Instantly campaign syncs to completed', async () => {
    db.campaigns = [localCampaign('active')]
    vi.stubGlobal('fetch', stubFetch([analyticsRow({ campaign_status: 3 })]))

    await POST(cronRequest())

    expect(onlyUpdate().payload.status).toBe('completed')
  })

  it('Running Subsequences (4) syncs to active, not completed — the campaign is still working', async () => {
    db.campaigns = [localCampaign('draft')]
    vi.stubGlobal('fetch', stubFetch([analyticsRow({ campaign_status: 4 })]))

    await POST(cronRequest())

    expect(onlyUpdate().payload.status).toBe('active')
  })

  it.each([
    [-1, 'Accounts Unhealthy'],
    [-2, 'Bounce Protect'],
    [-99, 'Account Suspended'],
  ])('an abnormal stop (%i, %s) stores as paused and is still counted as a real update', async (raw) => {
    db.campaigns = [localCampaign('active')]
    vi.stubGlobal('fetch', stubFetch([analyticsRow({ campaign_status: raw })]))

    const response = await POST(cronRequest())
    const body = await response.json()

    expect(onlyUpdate().payload.status).toBe('paused')
    expect(body.campaign_stats.updated).toBe(1)
  })

  it('does not count statusChanged when Instantly agrees with what we already stored', async () => {
    db.campaigns = [localCampaign('active')]
    vi.stubGlobal('fetch', stubFetch([analyticsRow({ campaign_status: 1 })]))

    const response = await POST(cronRequest())
    const body = await response.json()

    expect(onlyUpdate().payload.status).toBe('active')
    expect(body.campaign_stats.statusChanged).toBe(0)
    // Counters and the freshness stamp are still written every run.
    expect(body.campaign_stats.updated).toBe(1)
  })

  it('leaves status untouched when Instantly sends a value outside its own enum', async () => {
    db.campaigns = [localCampaign('draft')]
    vi.stubGlobal('fetch', stubFetch([analyticsRow({ campaign_status: 77 })]))

    const response = await POST(cronRequest())
    const body = await response.json()

    const { payload } = onlyUpdate()
    // Absent key, not a guess: the stored value survives.
    expect('status' in payload).toBe(false)
    // The counters are still trustworthy, so they are still written.
    expect(payload.sent_count).toBe(15)
    expect(body.campaign_stats.updated).toBe(1)
    expect(body.campaign_stats.statusChanged).toBe(0)
  })

  it('no longer filters on status, so every campaign with an external_id is refreshed', async () => {
    // Two campaigns, neither of them locally 'active'. Under the old filter both were
    // excluded and nothing was ever written.
    db.campaigns = [
      { id: 'internal-a', organisation_id: 'org-a', external_id: EXT, status: 'draft' },
      { id: 'internal-b', organisation_id: 'org-a', external_id: 'ext-b', status: 'completed' },
    ]
    vi.stubGlobal('fetch', stubFetch([
      analyticsRow(),
      analyticsRow({ campaign_id: 'ext-b', campaign_status: 2, emails_sent_count: 7 }),
    ]))

    await POST(cronRequest())

    expect(db.campaignUpdates).toHaveLength(2)
    const byId = Object.fromEntries(db.campaignUpdates.map(u => [u.id, u.payload]))
    expect(byId['internal-a'].status).toBe('active')
    expect(byId['internal-b'].status).toBe('paused')
    expect(byId['internal-b'].sent_count).toBe(7)
  })
})

// ── Problem B: a campaign with no analytics row is a named failure ────────────

describe('a registered external_id with no Instantly analytics row is a failure, not a skip', () => {
  it('records an error naming the external_id, and the run does NOT report clean', async () => {
    // Exactly the two mock rows in production: local campaigns whose external_ids were
    // never real Instantly campaigns. The analytics call returns nothing for them.
    db.campaigns = [localCampaign('active', 'mock-campaign-1785956498252')]
    vi.stubGlobal('fetch', stubFetch([]))

    const response = await POST(cronRequest())
    const body = await response.json()

    // No update was attempted: there was nothing trustworthy to write.
    expect(db.campaignUpdates).toHaveLength(0)
    expect(body.campaign_stats.missingAnalytics).toBe(1)
    expect(body.campaign_stats.errors).toBe(1)
    expect(body.campaign_stats.updated).toBe(0)
    // The run is not clean. This is the whole difference from a skip.
    expect(body.ok).toBe(false)
  })

  it('names the offending external_id in the cron_heartbeats detail, not just a count', async () => {
    db.campaigns = [localCampaign('active', 'b1234567-mock-4000-a000-staging000001')]
    vi.stubGlobal('fetch', stubFetch([]))

    await POST(cronRequest())

    expect(db.heartbeats).toHaveLength(1)
    const hb = db.heartbeats[0]
    expect(hb.ok).toBe(false)
    expect(hb.detail as string).toContain('b1234567-mock-4000-a000-staging000001')
    expect(hb.detail as string).toContain('no Instantly analytics row')
  })

  it('marks the Sentry check-in error and raises an exception naming the cause', async () => {
    db.campaigns = [localCampaign('active', 'mock-campaign-1785956498252')]
    vi.stubGlobal('fetch', stubFetch([]))

    await POST(cronRequest())

    const statuses = sentry.captureCheckIn.mock.calls.map(c => c[0].status)
    expect(statuses).toContain('error')
    expect(sentry.captureException).toHaveBeenCalled()
    const raised = sentry.captureException.mock.calls[0][0]
    expect(raised.message).toContain('mock-campaign-1785956498252')
  })

  it('a real campaign still refreshes cleanly alongside a mock one that fails', async () => {
    // The production shape today: one real campaign, one mock. The mock must not stop
    // the real one from getting its stats, and must not be hidden by it either.
    db.campaigns = [
      { id: 'internal-real', organisation_id: 'org-a', external_id: EXT, status: 'draft' },
      { id: 'internal-mock', organisation_id: 'org-a', external_id: 'mock-campaign-1785956498252', status: 'active' },
    ]
    vi.stubGlobal('fetch', stubFetch([analyticsRow()]))

    const response = await POST(cronRequest())
    const body = await response.json()

    // The real one was refreshed in full.
    expect(db.campaignUpdates).toHaveLength(1)
    expect(db.campaignUpdates[0].id).toBe('internal-real')
    expect(db.campaignUpdates[0].payload.status).toBe('active')
    expect(db.campaignUpdates[0].payload.sent_count).toBe(15)

    // And the mock one is still loud.
    expect(body.campaign_stats.updated).toBe(1)
    expect(body.campaign_stats.missingAnalytics).toBe(1)
    expect(body.ok).toBe(false)
  })

  it('reports ok: true when every registered campaign resolves', async () => {
    // The end state once the mock rows are cleaned. Guards against the failure path
    // being so eager that a healthy workspace can never go green.
    db.campaigns = [localCampaign('draft')]
    vi.stubGlobal('fetch', stubFetch([analyticsRow()]))

    const response = await POST(cronRequest())
    const body = await response.json()

    expect(body.campaign_stats.missingAnalytics).toBe(0)
    expect(body.campaign_stats.errors).toBe(0)
    expect(body.ok).toBe(true)
    expect(db.heartbeats[0].ok).toBe(true)
  })

  it('a database update failure is also carried into the heartbeat, named', async () => {
    db.campaigns = [localCampaign('draft')]
    db.campaignUpdateError = { message: 'permission denied for table campaigns' }
    vi.stubGlobal('fetch', stubFetch([analyticsRow()]))

    const response = await POST(cronRequest())
    const body = await response.json()

    expect(body.campaign_stats.errors).toBe(1)
    // Not a missing analytics row — the breakdown stays honest about which cause it was.
    expect(body.campaign_stats.missingAnalytics).toBe(0)
    expect(body.ok).toBe(false)
    expect(db.heartbeats[0].detail as string).toContain('permission denied')
  })
})

// ── People are not emails ─────────────────────────────────────────────────────

describe('contacted_count is stored separately, because emails are not people', () => {
  it('stores contacted and unsubscribed counts alongside the email counters', async () => {
    // The live shape: 15 people in the list, 26 emails out across the sequence steps.
    // A client overview that reported 26 prospects contacted would be wrong by 73%.
    vi.stubGlobal('fetch', stubFetch([analyticsRow({
      emails_sent_count: 26,
      leads_count: 15,
      new_leads_contacted_count: 15,
      unsubscribed_count: 1,
      reply_count: 1,
    })]))

    await POST(cronRequest())
    const { payload } = onlyUpdate()

    expect(payload.sent_count).toBe(26)
    expect(payload.contacted_count).toBe(15)
    expect(payload.unsubscribed_count).toBe(1)
    expect(payload.contacted_count).not.toBe(payload.sent_count)
  })

  it('ignores contacted_count entirely, even when it is the only people-looking field', async () => {
    // The live 2026-09-03 response, field for field. contacted_count reads 52 against 24
    // leads and 60 emails. Writing it is the defect this test exists to keep out.
    vi.stubGlobal('fetch', stubFetch([{
      campaign_id: EXT,
      campaign_status: 1,
      leads_count: 24,
      new_leads_contacted_count: 24,
      contacted_count: 52,
      emails_sent_count: 60,
      reply_count: 2,
      bounced_count: 0,
      unsubscribed_count: 0,
    }]))

    await POST(cronRequest())
    const { payload } = onlyUpdate()

    expect(payload.contacted_count).toBe(24)
    expect(payload.sent_count).toBe(60)
    expect(payload.contacted_count).not.toBe(52)
  })

  it('leaves contacted_count unwritten when Instantly omits it, rather than storing a zero', async () => {
    // A zero here would be rendered to the client as "0 prospects contacted" against a
    // campaign that has sent mail. Not writing the column keeps the last good number.
    vi.stubGlobal('fetch', stubFetch([{
      campaign_id: EXT,
      campaign_status: 1,
      emails_sent_count: 5,
      reply_count: 0,
      bounced_count: 0,
    }]))

    await POST(cronRequest())
    const { payload } = onlyUpdate()

    expect(payload).not.toHaveProperty('contacted_count')
    expect(payload.unsubscribed_count).toBe(0)
    expect(payload.sent_count).toBe(5)
  })

  it('leaves contacted_count unwritten when it exceeds the campaign lead count', async () => {
    vi.stubGlobal('fetch', stubFetch([analyticsRow({
      leads_count: 24,
      new_leads_contacted_count: 52,
      emails_sent_count: 60,
    })]))

    await POST(cronRequest())
    const { payload } = onlyUpdate()

    expect(payload).not.toHaveProperty('contacted_count')
    // The email counters are still good and still written.
    expect(payload.sent_count).toBe(60)
  })
})
