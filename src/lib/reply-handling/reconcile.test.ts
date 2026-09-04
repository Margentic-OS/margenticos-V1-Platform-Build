// Tests for the reply reconciliation sweep behind MON-029.
//
// The sweep answers "does the provider hold a reply we never stored". These tests drive the
// REAL reconcileReplies against real HTTP response bodies and a fake Supabase.
//
// WHAT MATTERS MOST HERE IS THE NOT-A-PASS CASES. A reconciliation that reports "nothing
// missing" when it could not read the provider, or when there was nothing to compare, is
// worse than no reconciliation: it is a green light nobody earned. Three tests below exist
// only to prove the sweep refuses to claim coverage it does not have.
//
// MUTATION-PROVED: removing the `verdict.incomplete = true` on the unreachable path, or the
// providerReplyCount === 0 branch in buildDetail, turns the corresponding test red.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureCheckIn: vi.fn(() => 'mock-checkin-id'),
  flush: vi.fn(() => Promise.resolve()),
}))

import { reconcileReplies } from './reconcile'

const CAMPAIGN = { id: 'internal-a', organisation_id: 'org-a', external_id: 'campaign-a' }

/* eslint-disable @typescript-eslint/no-explicit-any */
function createFakeSupabase(opts: {
  storedEventIds?: string[]
  campaigns?: Array<typeof CAMPAIGN>
  campaignError?: string
} = {}) {
  const stored = new Set(opts.storedEventIds ?? [])
  const campaigns = opts.campaigns ?? [CAMPAIGN]
  // Every filter the sweep applies, recorded so a test can prove it was actually sent.
  const signalFilters: Array<Record<string, unknown>> = []

  const client: any = {
    signalFilters,
    from(table: string) {
      if (table === 'campaigns') {
        const b: any = {
          select: () => b,
          not: () => b,
          is: () => b,
          then: (resolve: (v: unknown) => unknown) =>
            resolve(
              opts.campaignError
                ? { data: null, error: { message: opts.campaignError } }
                : { data: campaigns, error: null }
            ),
        }
        return b
      }

      if (table === 'signals') {
        const filters: Record<string, unknown> = {}
        const b: any = {
          select: () => b,
          // Honoured, not swallowed. A fake that ignored these would let the sweep drop its
          // org scoping and still pass, which is the fake-does-not-honour-a-filter trap.
          eq: (col: string, val: unknown) => { filters[col] = val; return b },
          in: (col: string, vals: string[]) => {
            filters[col] = vals
            signalFilters.push({ ...filters })
            const matched = vals
              .filter(v => stored.has(v))
              .map(v => ({ external_event_id: v }))
            return Promise.resolve({ data: matched, error: null })
          },
        }
        return b
      }

      throw new Error(`fake supabase: unexpected table ${table}`)
    },
  }
  return client
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.INSTANTLY_API_ACTIVE = 'true'
  delete process.env.INSTANTLY_API_BASE_URL
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.INSTANTLY_API_ACTIVE
})

describe('reply reconciliation finds what the poller lost', () => {
  it('reports a reply the provider holds and we do not', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ items: [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }] })
    ))

    // e2 never made it into signals — exactly the lost-reply case.
    const client = createFakeSupabase({ storedEventIds: ['e1', 'e3'] })
    const verdict = await reconcileReplies(client, 'key', 'https://x.test', true)

    expect(verdict.providerReplyCount).toBe(3)
    expect(verdict.storedReplyCount).toBe(2)
    expect(verdict.missingCount).toBe(1)
    expect(verdict.missingSample).toEqual(['e2'])
    expect(verdict.detail).toContain('no signal row')
  })

  it('reports nothing missing when every provider reply has a row', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ items: [{ id: 'e1' }, { id: 'e2' }] })
    ))

    const client = createFakeSupabase({ storedEventIds: ['e1', 'e2'] })
    const verdict = await reconcileReplies(client, 'key', 'https://x.test', true)

    expect(verdict.missingCount).toBe(0)
    expect(verdict.incomplete).toBe(false)
    expect(verdict.detail).toContain('have a signal row')
  })

  it('scopes the signal lookup to the campaign organisation and the reply signal type', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ items: [{ id: 'e1' }] })))

    const client = createFakeSupabase({ storedEventIds: ['e1'] })
    await reconcileReplies(client, 'key', 'https://x.test', true)

    // Without the org filter the sweep would match another client's signal and report a
    // reply as present that this organisation never received.
    expect(client.signalFilters[0]).toMatchObject({
      organisation_id: 'org-a',
      source: 'instantly',
      signal_type: 'reply_received',
    })
  })
})

describe('the sweep refuses to claim coverage it has not earned', () => {
  it('an unreachable provider is incomplete and counted, never a clean pass', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'upstream' }, 503)))

    const client = createFakeSupabase({ storedEventIds: [] })
    const verdict = await reconcileReplies(client, 'key', 'https://x.test', true)

    expect(verdict.unreachableCampaigns).toBe(1)
    expect(verdict.incomplete).toBe(true)
    expect(verdict.missingCount).toBe(0)
    // The detail must not read like an all-clear. MON-029 turns this into PROBLEM.
    expect(verdict.detail).toContain('could not be read')
    expect(verdict.detail).not.toContain('have a signal row')
  })

  it('zero replies at the provider says so, rather than implying a pass', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ items: [] })))

    const client = createFakeSupabase()
    const verdict = await reconcileReplies(client, 'key', 'https://x.test', true)

    expect(verdict.providerReplyCount).toBe(0)
    expect(verdict.missingCount).toBe(0)
    // MON-029 maps this to UNKNOWN. The wording has to carry the same meaning for anyone
    // reading the detail line without the state next to it.
    expect(verdict.detail).toContain('not a pass')
  })

  it('a campaign read failure is incomplete rather than an empty all-clear', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ items: [] })))

    const client = createFakeSupabase({ campaignError: 'permission denied' })
    const verdict = await reconcileReplies(client, 'key', 'https://x.test', true)

    expect(verdict.incomplete).toBe(true)
    expect(verdict.campaignsChecked).toBe(0)
    expect(verdict.detail).toContain('Could not read registered campaigns')
  })
})
