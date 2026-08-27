// Tests for the live sending-health refresh inside the instantly-poll route.
//
// WHAT THIS IS PROTECTING. campaigns.status is INTENT. It is a copy of Instantly's
// campaign_status and it says what somebody meant a campaign to do. A campaign sitting at
// 'active' can be sending precisely nothing: outside its schedule window, out of leads,
// at its daily cap, or with every sending account already at its own cap. The client
// dashboard prints the word "live" off sending_state and never off status, because
// telling a client mail is flowing while their accounts are at limit is not a smaller lie
// than the placeholder copy it replaced.
//
// These drive the REAL POST handler. The only substitutions are the process boundaries a
// test cannot reach: the Supabase client, Sentry, and global fetch. Every assertion is on
// the payload the production code actually sent to the database.
//
// The enum is pinned in the handler's own contract test. What is pinned HERE is the
// wiring: which campaigns get asked, what lands in the update, and what happens to the
// run when the call fails.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const log = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: log }))

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
  sending_state: string | null
}

const db = vi.hoisted(() => ({
  sendingHealthTool: null as null | { tool_name: string; is_active: boolean },
  heartbeats: [] as Record<string, unknown>[],
  campaigns: [] as Array<{
    id: string
    organisation_id: string
    external_id: string
    status: string
    sending_state: string | null
  }>,
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

const CRON_SECRET = 'test-secret-12345'
const EXT = 'cf695496-dba1-4bcb-beae-1b6ca28209d6'
const GHOST = 'b1234567-mock-4000-a000-staging000001'

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

function analyticsRow(campaignId = EXT, overrides: Record<string, unknown> = {}) {
  return {
    campaign_name: 'Margentic - send 1 (15 prospects)',
    campaign_id: campaignId,
    campaign_status: 1,
    emails_sent_count: 26,
    reply_count: 1,
    bounced_count: 0,
    ...overrides,
  }
}

function sendingStatusBody(status: string | null) {
  return {
    diagnostics: {
      campaign_id: EXT,
      last_updated: '2026-08-24T15:15:00.000Z',
      status,
      issue_tracking: { current_status_code: status, consecutive_loops_with_issue: 0 },
    },
    summary: { status, status_message: 'unused by the mapping' },
  }
}

// Records every sending-status URL the route asked for, so a test can assert on WHICH
// campaigns were asked about rather than only on how many calls happened.
const sendingCalls: string[] = []

// `sending` is either a body to return or a status code to fail with.
function stubFetch(rows: unknown[], sending: unknown | number = sendingStatusBody('healthy')) {
  return vi.fn(async (url: string | URL) => {
    const u = String(url)
    if (u.includes('/campaigns/analytics')) return jsonResponse(rows)
    if (u.includes('/sending-status')) {
      sendingCalls.push(u)
      if (typeof sending === 'number') return jsonResponse({ message: 'nope' }, sending)
      return jsonResponse(sending)
    }
    if (u.includes('/emails')) return jsonResponse({ items: [] })
    return jsonResponse({ items: [] })
  })
}

function localCampaign(
  external_id: string = EXT,
  sending_state: string | null = null,
  id = 'internal-a',
): CampaignRow {
  return { id, organisation_id: 'org-a', external_id, status: 'active', sending_state }
}

function updateFor(id: string) {
  const row = db.campaignUpdates.find(u => u.id === id)
  expect(row, `no campaigns update was made for ${id}`).toBeDefined()
  return row!.payload
}

beforeEach(() => {
  vi.clearAllMocks()
  db.heartbeats.length = 0
  db.campaignUpdates.length = 0
  db.campaignUpdateError = null
  db.campaigns = [localCampaign()]
  sendingCalls.length = 0
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

// ── The happy path ────────────────────────────────────────────────────────────

describe('sending health is stored alongside the counters, never derived from status', () => {
  it('a healthy campaign stores sending, the raw code, and a fresh timestamp', async () => {
    vi.stubGlobal('fetch', stubFetch([analyticsRow()]))

    const response = await POST(cronRequest())
    const body = await response.json()

    const payload = updateFor('internal-a')
    expect(payload.sending_state).toBe('sending')
    expect(payload.sending_status_raw).toBe('healthy')
    expect(typeof payload.sending_status_checked_at).toBe('string')

    // The counters and the intent status are still written in the same statement.
    expect(payload.sent_count).toBe(26)
    expect(payload.replied_count).toBe(1)
    expect(payload.status).toBe('active')

    expect(body.ok).toBe(true)
    expect(body.campaign_stats.sendingChecked).toBe(1)
    expect(body.campaign_stats.sendingErrors).toBe(0)
  })

  it('asks the sending-status endpoint for the campaign by its Instantly id', async () => {
    vi.stubGlobal('fetch', stubFetch([analyticsRow()]))
    await POST(cronRequest())

    expect(sendingCalls).toHaveLength(1)
    expect(sendingCalls[0]).toContain(`/campaigns/${EXT}/sending-status`)
  })

  it('an Instantly-active campaign at its daily cap is NOT recorded as sending', async () => {
    // The exact failure mode this column exists to prevent: status says active, so the
    // old dashboard would have said live, while nothing is going out.
    vi.stubGlobal('fetch', stubFetch([analyticsRow()], sendingStatusBody('account_daily_limit_met')))

    const response = await POST(cronRequest())
    const payload = updateFor('internal-a')

    expect(payload.status).toBe('active')          // intent, unchanged
    expect(payload.sending_state).toBe('limit_reached')
    expect(payload.sending_state).not.toBe('sending')
    expect((await response.json()).ok).toBe(true)  // not sending is not a failure
  })

  it('a campaign stopped by Instantly is stored as blocked and logged loudly', async () => {
    vi.stubGlobal('fetch', stubFetch([analyticsRow()], sendingStatusBody('campaign_account_suspended')))

    await POST(cronRequest())

    expect(updateFor('internal-a').sending_state).toBe('blocked')
    // 'waiting' and 'limit_reached' clear themselves; 'blocked' needs a human, so it has
    // to reach observability every tick it persists.
    const blockedWarn = log.warn.mock.calls.find(
      c => String(c[0]).includes('sending is blocked')
    )
    expect(blockedWarn).toBeDefined()
    expect((blockedWarn![1] as Record<string, unknown>).raw_status).toBe('campaign_account_suspended')
  })

  it('does not log the blocked warning for a self-clearing obstruction', async () => {
    vi.stubGlobal('fetch', stubFetch([analyticsRow()], sendingStatusBody('out_of_schedule')))
    await POST(cronRequest())

    expect(updateFor('internal-a').sending_state).toBe('waiting')
    expect(log.warn.mock.calls.some(c => String(c[0]).includes('sending is blocked'))).toBe(false)
  })
})

// ── Not knowing is stored as not knowing ──────────────────────────────────────

describe('an unestablished state is written as null, never left stale and never guessed', () => {
  it('clears the state but still stamps the timestamp when Instantly has no data', async () => {
    // Documented behaviour: "Returns null for both fields if no data is available."
    // A previous reading of 'sending' must not survive this, or the dashboard keeps
    // claiming live off a value Instantly has stopped standing behind.
    db.campaigns = [localCampaign(EXT, 'sending')]
    vi.stubGlobal('fetch', stubFetch([analyticsRow()], { diagnostics: null, summary: null }))

    const response = await POST(cronRequest())
    const payload = updateFor('internal-a')

    expect(payload.sending_state).toBeNull()
    expect(payload.sending_status_raw).toBeNull()
    // Stamped anyway: "we asked and Instantly had nothing" is a different fact from
    // "we have not asked since Tuesday", and the dashboard has to tell them apart.
    expect(typeof payload.sending_status_checked_at).toBe('string')

    expect((await response.json()).ok).toBe(true)
  })

  it('clears the state for a code outside the enum and keeps the code for diagnosis', async () => {
    db.campaigns = [localCampaign(EXT, 'sending')]
    vi.stubGlobal('fetch', stubFetch([analyticsRow()], sendingStatusBody('some_new_instantly_state')))

    await POST(cronRequest())
    const payload = updateFor('internal-a')

    expect(payload.sending_state).toBeNull()
    expect(payload.sending_status_raw).toBe('some_new_instantly_state')
  })
})

// ── Failure ───────────────────────────────────────────────────────────────────

describe('a sending-status failure is a named failure, and it never costs the counters', () => {
  it('counts the error, names it in the heartbeat, and turns the run red', async () => {
    vi.stubGlobal('fetch', stubFetch([analyticsRow()], 500))

    const response = await POST(cronRequest())
    const body = await response.json()

    expect(body.ok).toBe(false)
    expect(body.campaign_stats.sendingErrors).toBe(1)
    expect(body.campaign_stats.errors).toBe(1)

    expect(db.heartbeats).toHaveLength(1)
    expect(db.heartbeats[0].ok).toBe(false)
    expect(String(db.heartbeats[0].detail)).toContain('sending-status failed')
    expect(String(db.heartbeats[0].detail)).toContain('internal-a')
    expect(sentry.captureException).toHaveBeenCalled()
  })

  it('still writes the counters, and leaves the previous sending reading untouched', async () => {
    // The counters came from the analytics call and are still good. The sending fields
    // are omitted entirely, so the stored value keeps its OLD sending_status_checked_at.
    // Staleness there is what tells the dashboard not to trust it — refreshing the
    // timestamp while failing to refresh the state would erase that signal.
    vi.stubGlobal('fetch', stubFetch([analyticsRow()], 500))

    await POST(cronRequest())
    const payload = updateFor('internal-a')

    expect(payload.sent_count).toBe(26)
    expect(payload.replied_count).toBe(1)
    expect(payload.status).toBe('active')
    expect(payload).not.toHaveProperty('sending_state')
    expect(payload).not.toHaveProperty('sending_status_raw')
    expect(payload).not.toHaveProperty('sending_status_checked_at')
  })

  it('a rate limit fails the run rather than being read as "not sending"', async () => {
    vi.stubGlobal('fetch', stubFetch([analyticsRow()], 429))

    const body = await (await POST(cronRequest())).json()
    expect(body.ok).toBe(false)
    expect(body.campaign_stats.sendingErrors).toBe(1)
    expect(updateFor('internal-a')).not.toHaveProperty('sending_state')
  })
})

// ── Scope ─────────────────────────────────────────────────────────────────────

describe('only campaigns Instantly actually knows about are asked', () => {
  it('skips the sending-status call for a row with no analytics row, so it fails once not twice', async () => {
    // A campaigns row pointing at a campaign that does not exist in Instantly is already
    // a named failure in the analytics pass. Asking sending-status for it too would raise
    // a second error for one underlying fault and double the count in the heartbeat.
    db.campaigns = [localCampaign(EXT, null, 'internal-a'), localCampaign(GHOST, null, 'internal-ghost')]
    vi.stubGlobal('fetch', stubFetch([analyticsRow()]))

    const body = await (await POST(cronRequest())).json()

    expect(sendingCalls).toHaveLength(1)
    expect(sendingCalls[0]).toContain(EXT)
    expect(sendingCalls[0]).not.toContain(GHOST)

    expect(body.campaign_stats.missingAnalytics).toBe(1)
    expect(body.campaign_stats.sendingErrors).toBe(0)
    expect(body.campaign_stats.errors).toBe(1)  // one fault, counted once
  })

  it('a clean run names the sending-status checks in the heartbeat detail', async () => {
    vi.stubGlobal('fetch', stubFetch([analyticsRow()]))
    await POST(cronRequest())

    expect(db.heartbeats[0].ok).toBe(true)
    expect(String(db.heartbeats[0].detail)).toContain('1 sending-status check(s)')
  })
})
