// Tests for polling_cursors instrumentation.
//
// These drive the REAL pollInstantlyLeadStatus and assert on the actual row the
// production code upserts into polling_cursors. Nothing here asserts a constant or a
// flag the test itself set: the only inputs are the HTTP responses the stubbed fetch
// returns, and the only assertions are on what the real code wrote as a result.
//
// Detection logic is deliberately untouched by this suite. It asserts bookkeeping only.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureCheckIn: vi.fn(() => 'mock-checkin-id'),
  flush: vi.fn(() => Promise.resolve()),
}))

import { pollInstantlyLeadStatus, INSTANTLY_LEAD_STATUS_BOUNCED } from './instantly'

// ── Fake Supabase ─────────────────────────────────────────────────────────────
// Records every polling_cursors upsert so tests can inspect exactly which columns the
// real code chose to write, including which ones it deliberately omitted.

interface FakeCampaign {
  id: string
  organisation_id: string
  external_id: string
}

function createFakeSupabase(opts: {
  campaigns: FakeCampaign[]
  campaignsError?: { message: string }
  priorErrorCount?: number
}) {
  const cursorUpserts: Record<string, unknown>[] = []
  const signalInserts: Record<string, unknown>[] = []

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const client: any = {
    from(table: string) {
      if (table === 'campaigns') {
        const builder: any = {
          select: () => builder,
          not: () => builder,
          is: () => builder,
          eq: () => builder,
          then: (resolve: (v: unknown) => unknown) =>
            resolve(
              opts.campaignsError
                ? { data: null, error: opts.campaignsError }
                : { data: opts.campaigns, error: null }
            ),
        }
        return builder
      }

      if (table === 'polling_cursors') {
        const builder: any = {
          select: () => builder,
          is: () => builder,
          eq: () => builder,
          maybeSingle: async () => ({
            data: { last_cursor: null, error_count: opts.priorErrorCount ?? 0 },
            error: null,
          }),
          upsert: async (row: Record<string, unknown>) => {
            cursorUpserts.push(row)
            return { error: null }
          },
        }
        return builder
      }

      if (table === 'signals') {
        return {
          insert: async (row: Record<string, unknown>) => {
            signalInserts.push(row)
            return { error: null }
          },
        }
      }

      throw new Error(`fake supabase: unexpected table ${table}`)
    },
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return { client, cursorUpserts, signalInserts }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const CAMPAIGN_A: FakeCampaign = {
  id: 'internal-a',
  organisation_id: 'org-a',
  external_id: 'instantly-campaign-a',
}
const CAMPAIGN_B: FakeCampaign = {
  id: 'internal-b',
  organisation_id: 'org-b',
  external_id: 'instantly-campaign-b',
}

describe('polling_cursors instrumentation — pollInstantlyLeadStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Flag on + no base URL override → the real fetch path, which the stub below intercepts.
    process.env.INSTANTLY_API_ACTIVE = 'true'
    delete process.env.INSTANTLY_API_BASE_URL
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.INSTANTLY_API_ACTIVE
  })

  it('stamps last_polled_at when Instantly answers 200, even with zero leads returned', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ items: [], pagination: {} })))

    const { client, cursorUpserts } = createFakeSupabase({ campaigns: [CAMPAIGN_A] })

    const result = await pollInstantlyLeadStatus(
      client,
      'test-key',
      INSTANTLY_LEAD_STATUS_BOUNCED,
      'email_bounced'
    )

    expect(result.polled).toBe(true)
    expect(result.attempted).toBe(true)
    expect(result.errors).toBe(0)

    expect(cursorUpserts).toHaveLength(1)
    const row = cursorUpserts[0]
    expect(row.resource).toBe('leads_bounced')
    // The whole point: a successful call that returned nothing is still a poll.
    expect(typeof row.last_polled_at).toBe('string')
    expect(Number.isNaN(Date.parse(row.last_polled_at as string))).toBe(false)
    expect(typeof row.last_run_at).toBe('string')
    expect(row.error_count).toBe(0)
    expect(row.last_error).toBeNull()
  })

  it('does NOT stamp last_polled_at when every Instantly call fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream exploded', { status: 500 })))

    const { client, cursorUpserts } = createFakeSupabase({ campaigns: [CAMPAIGN_A] })

    const result = await pollInstantlyLeadStatus(
      client,
      'test-key',
      INSTANTLY_LEAD_STATUS_BOUNCED,
      'email_bounced'
    )

    expect(result.attempted).toBe(true)
    expect(result.polled).toBe(false)
    expect(result.errors).toBeGreaterThan(0)

    expect(cursorUpserts).toHaveLength(1)
    const row = cursorUpserts[0]
    // Absent key, not a null value: omitting it leaves any prior value intact.
    expect('last_polled_at' in row).toBe(false)
    // last_run_at still written — the run was attempted.
    expect(typeof row.last_run_at).toBe('string')
  })

  it('writes the HTTP status code and body into last_error on a failed poll', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('campaign not found', { status: 404 })))

    const { client, cursorUpserts } = createFakeSupabase({
      campaigns: [CAMPAIGN_A],
      priorErrorCount: 7,
    })

    await pollInstantlyLeadStatus(client, 'test-key', INSTANTLY_LEAD_STATUS_BOUNCED, 'email_bounced')

    const row = cursorUpserts[0]
    expect(typeof row.last_error).toBe('string')
    expect(row.last_error as string).toContain('404')
    expect(row.last_error as string).toContain('campaign not found')
    expect(row.last_error as string).toContain(CAMPAIGN_A.external_id)
    // Incremented from the existing count, not reset.
    expect(row.error_count).toBe(8)
  })

  it('does not let a later campaign succeeding erase the first failure of the same run', async () => {
    // Campaign A fails, campaign B succeeds. Old code called setCursorSuccess at the end
    // and wiped last_error to null. This asserts the failure survives.
    const fetchStub = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body ?? '')
      if (body.includes(CAMPAIGN_A.external_id)) {
        return new Response('rate limited', { status: 429 })
      }
      return jsonResponse({ items: [], pagination: {} })
    })
    vi.stubGlobal('fetch', fetchStub)

    const { client, cursorUpserts } = createFakeSupabase({
      campaigns: [CAMPAIGN_A, CAMPAIGN_B],
      priorErrorCount: 0,
    })

    const result = await pollInstantlyLeadStatus(
      client,
      'test-key',
      INSTANTLY_LEAD_STATUS_BOUNCED,
      'email_bounced'
    )

    // One campaign did reach Instantly, so the resource counts as polled.
    expect(result.polled).toBe(true)
    expect(result.errors).toBe(1)

    const row = cursorUpserts[0]
    expect(typeof row.last_polled_at).toBe('string')
    // The real error is still there, not nulled by campaign B's success.
    expect(row.last_error as string).toContain('429')
    expect(row.last_error as string).toContain(CAMPAIGN_A.external_id)
    expect(row.error_count).toBe(1)
  })

  it('never advances last_cursor for leads_bounced — the full re-scan has no cursor', async () => {
    // Instantly returns a cursor. The resource must still not persist one, because
    // resuming from it would skip leads that bounce after their creation date.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ items: [], pagination: { next_starting_after: 'cur-999' } }))
    )

    const { client, cursorUpserts } = createFakeSupabase({ campaigns: [CAMPAIGN_A] })

    await pollInstantlyLeadStatus(client, 'test-key', INSTANTLY_LEAD_STATUS_BOUNCED, 'email_bounced')

    const row = cursorUpserts[0]
    expect('last_cursor' in row).toBe(false)
  })

  it('treats "no registered campaigns" as not polled rather than as a clean scan', async () => {
    const fetchStub = vi.fn()
    vi.stubGlobal('fetch', fetchStub)

    const { client, cursorUpserts } = createFakeSupabase({ campaigns: [] })

    const result = await pollInstantlyLeadStatus(
      client,
      'test-key',
      INSTANTLY_LEAD_STATUS_BOUNCED,
      'email_bounced'
    )

    expect(fetchStub).not.toHaveBeenCalled()
    expect(result.attempted).toBe(false)
    expect(result.polled).toBe(false)
    expect(result.errors).toBe(0)

    const row = cursorUpserts[0]
    // Not an error, but not a poll either.
    expect('last_polled_at' in row).toBe(false)
    expect(row.error_count).toBe(0)
    expect(row.last_error).toBeNull()
    expect(typeof row.last_run_at).toBe('string')
  })

  it('records a campaigns-query failure as a failure instead of a silent success', async () => {
    vi.stubGlobal('fetch', vi.fn())

    const { client, cursorUpserts } = createFakeSupabase({
      campaigns: [],
      campaignsError: { message: 'relation "campaigns" does not exist' },
      priorErrorCount: 2,
    })

    const result = await pollInstantlyLeadStatus(
      client,
      'test-key',
      INSTANTLY_LEAD_STATUS_BOUNCED,
      'email_bounced'
    )

    expect(result.errors).toBe(1)
    expect(result.polled).toBe(false)

    const row = cursorUpserts[0]
    expect('last_polled_at' in row).toBe(false)
    expect(row.error_count).toBe(3)
    expect(row.last_error as string).toContain('campaigns query failed')
  })
})
