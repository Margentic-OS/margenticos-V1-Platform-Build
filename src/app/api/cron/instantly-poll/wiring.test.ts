// THE CRON ROUTE ACTUALLY CALLS EACH SWEEP.
//
// ═══════════════════════════════════════════════════════════════════════════════
// WHY A FILE THAT ONLY ASSERTS "IT WAS CALLED"
//
// Every other test in this directory drives the REAL pollers and asserts on the rows they
// produced. That is the right shape for behaviour, and it is blind to exactly one thing:
// whether the route still calls them at all.
//
// A previous session deleted an entire sweep from a cron route and all 51 tests in that
// directory stayed green, because every one tested the RESULT and none tested that the
// thing was CALLED. A result-shaped test on a sweep that no longer runs asserts about a
// default-initialised zero and passes.
//
// route.ts:107 assigns `results.replies = await pollInstantlyReplies(...)`, and
// results.replies is pre-initialised to { written: 0, errors: 0, attempted: false, ... }.
// Delete the assignment and the ok rule still computes, the heartbeat still writes, and
// the route still returns 200 with a clean-looking body. Nothing in route.test.ts fails.
//
// So this file mocks the polling module and asserts the call itself. It is deliberately
// the ONLY file here that does, because a mocked poller cannot tell you anything about
// polling — the two kinds of test are complements, not substitutes.
//
// MUTATION-PROVED: deleting the pollInstantlyReplies call in route.ts turns the first test
// red. Deleting either lead-status call turns the second red.

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

const emptyPollResult = { written: 0, skipped: 0, errors: 0, attempted: false, polled: false }

// The two sweeps under test. Real constants are re-exported unchanged so the route's
// status arguments stay meaningful — mocking them to arbitrary numbers would let the
// second test pass while the route asked the provider for the wrong thing.
const polling = vi.hoisted(() => ({
  pollInstantlyReplies: vi.fn(async () => ({
    written: 0, skipped: 0, errors: 0, attempted: true, polled: true,
  })),
  pollInstantlyLeadStatus: vi.fn(async () => ({
    written: 0, skipped: 0, errors: 0, attempted: true, polled: true,
  })),
  INSTANTLY_LEAD_STATUS_BOUNCED: -1,
  INSTANTLY_LEAD_STATUS_UNSUBSCRIBED: -2,
  INSTANTLY_LEAD_STATUS_VERIFIED: true,
}))
vi.mock('@/lib/integrations/polling/instantly', () => polling)

vi.mock('@/lib/integrations/handlers/instantly/auth', () => ({
  getInstantlyApiKey: vi.fn(async () => 'test-key'),
  getInstantlyApiActive: vi.fn(async () => true),
}))

vi.mock('@/lib/sending-health/sync', () => ({
  syncSendingHealth: vi.fn(async () => ({ errors: [], overallState: 'healthy', detail: 'ok' })),
}))

vi.mock('@/lib/suppression/carry', () => ({
  carryPendingSuppressions: vi.fn(async () => ({
    activeCount: 0, pendingCount: 0, carriedCount: 0, failedCount: 0,
    noOrgCount: 0, backoffCount: 0, incomplete: false, detail: 'nothing to carry',
  })),
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
          then: (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null }),
        }
        return builder
      }
      if (table === 'cron_heartbeats') {
        // The route ends the heartbeat insert with .throwOnError(), so the fake has to
        // offer it. Returning a bare promise here made both tests fail inside the route
        // AFTER the calls under test had already happened — a fake that is missing a
        // method fails loudly, which is the behaviour we want from it.
        return { insert: () => ({ throwOnError: async () => ({ error: null }) }) }
      }
      const builder: any = {
        select: () => builder,
        is: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: null, error: null }),
        upsert: async () => ({ error: null }),
        insert: async () => ({ error: null }),
        then: (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null }),
      }
      return builder
    },
  }),
  /* eslint-enable @typescript-eslint/no-explicit-any */
}))

import { POST } from './route'

const CRON_SECRET = 'test-secret-12345'

function cronRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/cron/instantly-poll', {
    method: 'POST',
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = CRON_SECRET
  process.env.INSTANTLY_API_ACTIVE = 'true'
  process.env.INSTANTLY_API_KEY_OVERRIDE = 'test-key'
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.INSTANTLY_API_ACTIVE
  delete process.env.INSTANTLY_API_KEY_OVERRIDE
})

describe('the instantly-poll route calls every sweep it is responsible for', () => {
  it('calls pollInstantlyReplies exactly once per run', async () => {
    await POST(cronRequest())

    // The assertion the result-shaped tests cannot make. results.replies is pre-initialised
    // to zeros, so deleting the call leaves every one of them green.
    expect(polling.pollInstantlyReplies).toHaveBeenCalledTimes(1)
  })

  it('calls pollInstantlyLeadStatus for BOTH bounced and unsubscribed', async () => {
    await POST(cronRequest())

    expect(polling.pollInstantlyLeadStatus).toHaveBeenCalledTimes(2)

    // By status argument, not by call count alone: two calls that both asked for bounces
    // would satisfy a bare count while unsubscribes silently stopped being polled.
    const statuses = polling.pollInstantlyLeadStatus.mock.calls.map(
      call => (call as unknown[])[2]
    )
    expect(statuses).toContain(polling.INSTANTLY_LEAD_STATUS_BOUNCED)
    expect(statuses).toContain(polling.INSTANTLY_LEAD_STATUS_UNSUBSCRIBED)
  })
})
