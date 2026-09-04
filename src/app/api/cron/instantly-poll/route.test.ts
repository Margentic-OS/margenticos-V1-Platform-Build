// Tests for the instantly-poll route's ok rule.
//
// These call the REAL POST handler, which calls the REAL pollers. The only things
// substituted are the process boundaries the route cannot reach in a test: the Supabase
// client, Sentry, and global fetch. Every assertion is on what the real code produced.
//
// The bug being locked out: the route previously returned ok: true and stamped the
// Sentry check-in 'ok' unconditionally, so a run in which every Instantly call failed
// read green on both.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

interface CapturedCheckIn {
  monitorSlug: string
  status: string
  checkInId?: string
}

const sentry = vi.hoisted(() => ({
  captureCheckIn: vi.fn(
    (_checkIn: { monitorSlug: string; status: string; checkInId?: string }, _config?: unknown) =>
      'mock-checkin-id'
  ),
  captureException: vi.fn(),
  flush: vi.fn(() => Promise.resolve()),
}))
vi.mock('@sentry/nextjs', () => sentry)

// Every check-in status the route recorded, in call order.
function capturedCheckInStatuses(): string[] {
  return sentry.captureCheckIn.mock.calls.map(call => (call[0] as CapturedCheckIn).status)
}

// Captures every row the route writes, across all tables.
const db = vi.hoisted(() => ({
  sendingHealthTool: null as null | { tool_name: string; is_active: boolean },
  heartbeats: [] as Record<string, unknown>[],
  cursorUpserts: [] as Record<string, unknown>[],
  campaigns: [] as Array<{ id: string; organisation_id: string; external_id: string }>,
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
          update: () => ({ eq: async () => ({ error: null }) }),
          then: (resolve: (v: unknown) => unknown) =>
            resolve({ data: db.campaigns, error: null }),
        }
        return builder
      }
      if (table === 'polling_cursors') {
        const builder: any = {
          select: () => builder,
          is: () => builder,
          eq: () => builder,
          maybeSingle: async () => ({ data: { last_cursor: null, error_count: 0 }, error: null }),
          upsert: async (row: Record<string, unknown>) => {
            db.cursorUpserts.push(row)
            return { error: null }
          },
        }
        return builder
      }
      if (table === 'signals') {
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

// The suppression carry sweep. Mocked here so these tests assert the WIRING — that the
// route runs it and reports what it said. carry.test.ts drives the real implementation
// against a fake that honours its filters.
const carryPendingSuppressions = vi.hoisted(() =>
  vi.fn(async () => ({
    activeCount: 3,
    pendingCount: 1,
    carriedCount: 1,
    failedCount: 0,
    noOrgCount: 0,
    backoffCount: 0,
    incomplete: false,
    detail: 'CARRY-SWEEP-RAN: 1 suppressed address(es) carried to the provider.',
  })),
)
vi.mock('@/lib/suppression/carry', () => ({ carryPendingSuppressions }))

import { POST } from './route'

const CRON_SECRET = 'test-secret-12345'

function cronRequest(secret = CRON_SECRET): NextRequest {
  return new NextRequest('http://localhost:3000/api/cron/instantly-poll', {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}` },
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('POST /api/cron/instantly-poll — the ok rule', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    db.heartbeats.length = 0
    db.cursorUpserts.length = 0
    db.campaigns = [
      { id: 'internal-a', organisation_id: 'org-a', external_id: 'instantly-campaign-a' },
    ]
    db.sendingHealthTool = null
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

  it('rejects a request without the cron secret', async () => {
    const response = await POST(cronRequest('wrong-secret'))
    expect(response.status).toBe(401)
  })

  // ── The carry sweep is wired in, and says so where an operator reads ────────
  //
  // WITHOUT THIS TEST THE FIX CAN BE DELETED SILENTLY. Mutation-tested 2026-09-04:
  // removing the carryPendingSuppressions call from the route failed NOTHING across all
  // 51 tests in this directory, because every other test here is about the poll result.
  // The sweep is what makes a suppression reach the provider when the poller can no
  // longer see the bounced lead, so a deletion that nothing notices is the whole defect
  // class this change exists to close.
  it('runs the suppression carry sweep and carries its verdict into the heartbeat', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ items: [] })))

    const response = await POST(cronRequest())
    const body = await response.json()

    expect(carryPendingSuppressions).toHaveBeenCalledTimes(1)
    // Deliberately says nothing about body.ok: this test is about the sweep running and
    // being reported, and the campaign fixture here makes the run unhealthy for its own
    // reasons. The next test isolates the ok rule.

    // Reported in the response...
    expect(body.suppression_carry.carriedCount).toBe(1)

    // ...and in the heartbeat, which is the line an operator actually reads. A sweep that
    // ran and said nothing anywhere visible is the shape MON-019 was found in: running,
    // silent, and indistinguishable from healthy.
    expect(db.heartbeats).toHaveLength(1)
    expect(String(db.heartbeats[0].detail)).toContain('CARRY-SWEEP-RAN')
  })

  it('does not let a carry sweep failure drag the poll run to not-ok', async () => {
    // Deliberate, and the reasoning is in the route. One address the provider will not
    // answer for would otherwise hold this heartbeat red for ever, and a permanently red
    // heartbeat cannot report the NEXT failure — it would mask the poll outage this
    // instrumentation exists to catch. MON-026 is the instrument for the carry.
    carryPendingSuppressions.mockResolvedValueOnce({
      activeCount: 3,
      pendingCount: 1,
      carriedCount: 0,
      failedCount: 1,
      noOrgCount: 0,
      backoffCount: 0,
      incomplete: false,
      detail: 'CARRY-SWEEP-RAN: 1 suppressed address(es) could not be carried.',
    })
    // No registered campaigns, so the campaign-stats refresh has nothing to resolve and
    // cannot contribute a failure of its own. The carry failure must then be the ONLY
    // thing that could drag ok down, which is what this test is about. Without this the
    // test would pass or fail for a reason unrelated to its subject.
    db.campaigns = []
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ items: [] })))

    const response = await POST(cronRequest())
    const body = await response.json()

    expect(body.suppression_carry.failedCount).toBe(1)
    expect(body.ok).toBe(true)
    expect(db.heartbeats[0].ok).toBe(true)
    expect(String(db.heartbeats[0].detail)).toContain('CARRY-SWEEP-RAN')
  })

  it('returns ok: false when every Instantly call fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream down', { status: 503 })))

    const response = await POST(cronRequest())
    const body = await response.json()

    expect(body.ok).toBe(false)
    expect(body.results.replies.polled).toBe(false)
    expect(body.results.bounces.polled).toBe(false)
    expect(body.results.unsubscribes.polled).toBe(false)

    // All three instruments must agree, not just the heartbeat.
    expect(db.heartbeats).toHaveLength(1)
    expect(db.heartbeats[0].ok).toBe(false)

    const statuses = capturedCheckInStatuses()
    expect(statuses).toContain('in_progress')
    expect(statuses).toContain('error')
    expect(statuses).not.toContain('ok')

    // A Sentry call in a serverless function is dropped unless it is flushed.
    expect(sentry.flush).toHaveBeenCalled()
  })

  it('returns ok: true when every resource reaches Instantly successfully', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        // Campaign analytics returns an array; the list endpoints return item pages.
        //
        // The analytics array must carry a row for the registered campaign. An empty
        // array used to be harmless here, but a registered external_id with no analytics
        // row is now a named failure rather than a silent skip, so an empty array would
        // make this a genuinely unhealthy run. The fixture is corrected rather than the
        // assertion relaxed: this test exists to prove a FULLY healthy run reads green.
        if (String(url).includes('/campaigns/analytics')) {
          return jsonResponse([
            {
              campaign_id: 'instantly-campaign-a',
              campaign_status: 1,
              emails_sent_count: 0,
              reply_count: 0,
              bounced_count: 0,
            },
          ])
        }
        return jsonResponse({ items: [], pagination: {} })
      })
    )

    const response = await POST(cronRequest())
    const body = await response.json()

    expect(body.ok).toBe(true)
    expect(body.results.replies.polled).toBe(true)
    expect(body.results.bounces.polled).toBe(true)
    expect(body.results.unsubscribes.polled).toBe(true)

    expect(db.heartbeats[0].ok).toBe(true)

    const statuses = capturedCheckInStatuses()
    expect(statuses).toContain('ok')
    expect(statuses).not.toContain('error')
    expect(sentry.captureException).not.toHaveBeenCalled()
    expect(sentry.flush).toHaveBeenCalled()
  })

  it('returns ok: false when only the lead-status resources fail', async () => {
    // Replies succeed, /leads/list fails. A partial failure must not read as a clean run.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        const target = String(url)
        if (target.includes('/leads/list')) return new Response('bad filter', { status: 400 })
        if (target.includes('/campaigns/analytics')) return jsonResponse([])
        return jsonResponse({ items: [], pagination: {} })
      })
    )

    const response = await POST(cronRequest())
    const body = await response.json()

    expect(body.results.replies.polled).toBe(true)
    expect(body.results.bounces.polled).toBe(false)
    expect(body.results.unsubscribes.polled).toBe(false)
    expect(body.ok).toBe(false)
    expect(db.heartbeats[0].ok).toBe(false)
  })

  it('reports a resource with nothing to poll without calling the run a failure', async () => {
    // No registered campaigns: the lead-status resources cannot poll, but nothing failed.
    db.campaigns = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        if (String(url).includes('/campaigns/analytics')) return jsonResponse([])
        return jsonResponse({ items: [], pagination: {} })
      })
    )

    const response = await POST(cronRequest())
    const body = await response.json()

    expect(body.results.bounces.attempted).toBe(false)
    expect(body.results.bounces.polled).toBe(false)
    expect(body.results.bounces.errors).toBe(0)
    expect(body.ok).toBe(true)
  })
  // ── Sending health is part of the ok rule ──────────────────────────────────
  //
  // Added 2026-08-27 with MON-023. The per-domain fetch rides along with this cron, and
  // an error in it MUST drag ok to false. Campaign stats were once outside the ok rule
  // for exactly this reason and a refresh that resolved nothing still reported green.

  it('a sending-health failure makes the run not ok', async () => {
    // A tool is registered but no handler is wired for it, so the capability lookup
    // throws inside syncSendingHealth and is captured as an error rather than escaping.
    db.sendingHealthTool = { tool_name: 'a-tool-with-no-handler', is_active: true }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        if (String(url).includes('/campaigns/analytics')) return jsonResponse([])
        return jsonResponse({ items: [], pagination: {} })
      })
    )

    const response = await POST(cronRequest())
    const body = await response.json()

    expect(body.sending_health.errors.length).toBeGreaterThan(0)
    expect(body.ok).toBe(false)
  })

  it('does not abort the poll when sending health fails', async () => {
    // Signals already written must survive a later failure in a different resource.
    db.sendingHealthTool = { tool_name: 'a-tool-with-no-handler', is_active: true }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        if (String(url).includes('/campaigns/analytics')) return jsonResponse([])
        return jsonResponse({ items: [], pagination: {} })
      })
    )

    const response = await POST(cronRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.results.replies.polled).toBe(true)
  })

  it('leaves ok true when no tool is registered for sending health', async () => {
    // Not-configured is not a failure. Otherwise the cron would be permanently red on any
    // deployment that has not registered the capability.
    //
    // No campaigns registered, so nothing else in the run can fail either. A registered
    // external_id with no analytics row IS a named failure, so leaving one here would
    // make ok false for a reason that has nothing to do with sending health.
    db.campaigns = []
    db.sendingHealthTool = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        if (String(url).includes('/campaigns/analytics')) return jsonResponse([])
        return jsonResponse({ items: [], pagination: {} })
      })
    )

    const response = await POST(cronRequest())
    const body = await response.json()

    expect(body.sending_health.attempted).toBe(false)
    expect(body.sending_health.errors).toEqual([])
    expect(body.ok).toBe(true)
  })
})
