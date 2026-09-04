// Tests for bounce and unsubscribe DETECTION.
//
// These drive the real pollInstantlyLeadStatus with real HTTP responses and assert on
// the signal rows and polling_cursors rows the production code actually wrote.
//
// Ground truth, Instantly API v2 Lead schema:
//   status (readOnly, number): 1 Active, 2 Paused, 3 Completed,
//                              -1 Bounced, -2 Unsubscribed, -3 Skipped
//
// Two bugs are locked out here:
//   1. The constants were inverted (BOUNCED was -2, UNSUBSCRIBED was -1).
//   2. The constants were strings, so any strict comparison against the numeric field
//      the API returns was false forever.
// And one root cause: the poller trusted the request filter and never read the row back.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureCheckIn: vi.fn(() => 'mock-checkin-id'),
  flush: vi.fn(() => Promise.resolve()),
}))

// The bounce path carries every suppressed address out to the sending provider through
// carryOneSuppression, which owns the provider call and the carry bookkeeping. Mocked here,
// and asserted on in the suppression file. carry.test.ts drives the real one.
//
// Mocked rather than served by the fake Supabase, deliberately. The real path resolves the
// capability from integrations_registry and then makes its own HTTP calls to /leads/list,
// which is the SAME endpoint this file's fetch stub serves for paging. Letting it through
// would fold provider-suppression requests into the call counts these tests use to prove
// paging behaviour, and a test that counts two different things cannot fail for one reason.
const carryOneSuppression = vi.fn(async () => ({
  status: 'confirmed' as const,
  stoppedLeadIds: [] as string[],
  error: null,
  signalMarkedProcessed: true,
}))
vi.mock('@/lib/suppression/carry', () => ({
  carryOneSuppression: (...args: unknown[]) => carryOneSuppression(...(args as [])),
}))

import {
  pollInstantlyLeadStatus,
  INSTANTLY_LEAD_STATUS_BOUNCED,
  INSTANTLY_LEAD_STATUS_UNSUBSCRIBED,
} from './instantly'

interface FakeCampaign {
  id: string
  organisation_id: string
  external_id: string
}

const CAMPAIGN: FakeCampaign = {
  id: 'internal-a',
  organisation_id: 'org-a',
  external_id: 'instantly-campaign-a',
}

function createFakeSupabase(campaigns: FakeCampaign[] = [CAMPAIGN]) {
  const cursorUpserts: Record<string, unknown>[] = []
  const signalInserts: Record<string, unknown>[] = []
  const suppressionInserts: Record<string, unknown>[] = []

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const client: any = {
    from(table: string) {
      if (table === 'campaigns') {
        const builder: any = {
          select: () => builder,
          not: () => builder,
          is: () => builder,
          eq: () => builder,
          then: (resolve: (v: unknown) => unknown) => resolve({ data: campaigns, error: null }),
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
            cursorUpserts.push(row)
            return { error: null }
          },
        }
        return builder
      }
      if (table === 'signals') {
        // writeSignal now chains .select('id') so the caller can record provenance
        // against the signal that caused a side effect. Detection assertions below are
        // unchanged; only the shape of the fake follows the production call.
        return {
          insert: (row: Record<string, unknown>) => ({
            select: async (_cols: string) => {
              signalInserts.push(row)
              return { data: [{ id: `signal-${signalInserts.length}` }], error: null }
            },
          }),
        }
      }
      if (table === 'suppressed_emails') {
        // Detection now feeds the global suppression list. These tests are about
        // detection, so the list is accepted and recorded but not asserted on here.
        // The wiring itself is covered in instantly.suppression.test.ts.
        return {
          insert: async (row: Record<string, unknown>) => {
            suppressionInserts.push(row)
            return { error: null }
          },
        }
      }
      throw new Error(`fake supabase: unexpected table ${table}`)
    },
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return { client, cursorUpserts, signalInserts, suppressionInserts }
}

// Serves one page of leads, then an empty page.
function serveLeads(leads: unknown[]) {
  let served = false
  return vi.fn(async () => {
    const body = served ? { items: [], pagination: {} } : { items: leads, pagination: {} }
    served = true
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
}

// Captures the JSON body of the last /leads/list request the poller sent.
function serveAndCaptureRequest(leads: unknown[]) {
  const bodies: Record<string, unknown>[] = []
  let served = false
  const fetchStub = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')))
    const body = served ? { items: [], pagination: {} } : { items: leads, pagination: {} }
    served = true
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  return { fetchStub, bodies }
}

describe('bounce and unsubscribe detection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.INSTANTLY_API_ACTIVE = 'true'
    delete process.env.INSTANTLY_API_BASE_URL
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.INSTANTLY_API_ACTIVE
  })

  it('writes an email_bounced signal for a returned lead carrying status -1', async () => {
    vi.stubGlobal('fetch', serveLeads([{ id: 'lead-bounced-1', email: 'a@example.com', status: -1 }]))

    const { client, signalInserts, cursorUpserts } = createFakeSupabase()

    const result = await pollInstantlyLeadStatus(
      client,
      'test-key',
      INSTANTLY_LEAD_STATUS_BOUNCED,
      'email_bounced'
    )

    expect(result.written).toBe(1)
    expect(result.errors).toBe(0)
    expect(signalInserts).toHaveLength(1)
    expect(signalInserts[0].signal_type).toBe('email_bounced')
    expect(signalInserts[0].external_event_id).toBe('lead-bounced-1')

    // A clean detection run leaves no error behind.
    expect(cursorUpserts[0].error_count).toBe(0)
    expect(cursorUpserts[0].last_error).toBeNull()
  })

  it('writes a lead_unsubscribed signal for a returned lead carrying status -2', async () => {
    vi.stubGlobal('fetch', serveLeads([{ id: 'lead-unsub-1', email: 'b@example.com', status: -2 }]))

    const { client, signalInserts } = createFakeSupabase()

    const result = await pollInstantlyLeadStatus(
      client,
      'test-key',
      INSTANTLY_LEAD_STATUS_UNSUBSCRIBED,
      'lead_unsubscribed'
    )

    expect(result.written).toBe(1)
    expect(result.errors).toBe(0)
    expect(signalInserts[0].signal_type).toBe('lead_unsubscribed')
  })

  it('does NOT write a bounce for a status -2 row returned by a bounced query, and raises a failure', async () => {
    // -2 is Unsubscribed. Under the old inverted constants this row was exactly what the
    // bounce poll asked for, and it was written as a bounce with no complaint.
    vi.stubGlobal('fetch', serveLeads([{ id: 'lead-unsub-2', email: 'c@example.com', status: -2 }]))

    const { client, signalInserts, cursorUpserts } = createFakeSupabase()

    const result = await pollInstantlyLeadStatus(
      client,
      'test-key',
      INSTANTLY_LEAD_STATUS_BOUNCED,
      'email_bounced'
    )

    expect(signalInserts).toHaveLength(0)
    expect(result.written).toBe(0)
    expect(result.errors).toBe(1)

    // The mismatch is a failure, not a silent skip: it reaches last_error and error_count.
    const row = cursorUpserts[0]
    expect(row.error_count).toBe(1)
    expect(row.last_error as string).toContain('status is -2, expected -1')
    expect(row.last_error as string).toContain('1/1 returned leads')
  })

  it('does NOT coerce a string "-1" into a numeric match', async () => {
    // Number('-1') === -1 would pass. Strict typeof checking is what makes a schema
    // change visible instead of silently absorbed.
    vi.stubGlobal('fetch', serveLeads([{ id: 'lead-stringy', email: 'd@example.com', status: '-1' }]))

    const { client, signalInserts, cursorUpserts } = createFakeSupabase()

    const result = await pollInstantlyLeadStatus(
      client,
      'test-key',
      INSTANTLY_LEAD_STATUS_BOUNCED,
      'email_bounced'
    )

    expect(signalInserts).toHaveLength(0)
    expect(result.errors).toBe(1)
    expect(cursorUpserts[0].last_error as string).toContain('status is string "-1", expected a number')
  })

  it('does NOT write a signal for a row with no status field at all', async () => {
    // What an ignored filter plus a renamed field looks like.
    vi.stubGlobal('fetch', serveLeads([{ id: 'lead-no-status', email: 'e@example.com' }]))

    const { client, signalInserts, cursorUpserts } = createFakeSupabase()

    const result = await pollInstantlyLeadStatus(
      client,
      'test-key',
      INSTANTLY_LEAD_STATUS_BOUNCED,
      'email_bounced'
    )

    expect(signalInserts).toHaveLength(0)
    expect(result.errors).toBe(1)
    expect(cursorUpserts[0].last_error as string).toContain('no status field')
  })

  it('writes only the matching rows when a page mixes statuses, and still reports the failure', async () => {
    // The shape of an ignored status filter: a whole page of mixed leads comes back.
    vi.stubGlobal(
      'fetch',
      // Addresses added 2026-08-21: a real Instantly lead always carries one, and a
      // bounced lead without one is now its own reported error (it cannot be
      // suppressed). Leaving them off would have this fixture testing that instead of
      // the mixed-status counting it exists for.
      serveLeads([
        { id: 'lead-1', email: 'one@example.com',   status: -1 },  // Bounced      → written
        { id: 'lead-2', email: 'two@example.com',   status: -2 },  // Unsubscribed → rejected
        { id: 'lead-3', email: 'three@example.com', status: 1 },   // Active       → rejected
        { id: 'lead-4', email: 'four@example.com',  status: -1 },  // Bounced      → written
      ])
    )

    const { client, signalInserts, cursorUpserts } = createFakeSupabase()

    const result = await pollInstantlyLeadStatus(
      client,
      'test-key',
      INSTANTLY_LEAD_STATUS_BOUNCED,
      'email_bounced'
    )

    expect(signalInserts.map(s => s.external_event_id)).toEqual(['lead-1', 'lead-4'])
    expect(result.written).toBe(2)
    expect(result.errors).toBe(2)

    // Two bad rows in one call is one failed call, not two.
    const row = cursorUpserts[0]
    expect(row.error_count).toBe(1)
    expect(row.last_error as string).toContain('2/4 returned leads did not carry status -1')
  })

  it('sends the corrected numeric status in the request filter, not a string', async () => {
    const { fetchStub, bodies } = serveAndCaptureRequest([])
    vi.stubGlobal('fetch', fetchStub)

    const { client } = createFakeSupabase()

    await pollInstantlyLeadStatus(client, 'test-key', INSTANTLY_LEAD_STATUS_BOUNCED, 'email_bounced')

    expect(bodies).toHaveLength(1)
    // -1 as a JSON number. Previously "-2" as a JSON string: wrong value, wrong type.
    expect(bodies[0].status).toBe(-1)
    expect(typeof bodies[0].status).toBe('number')
    expect(bodies[0].campaign).toBe(CAMPAIGN.external_id)
  })

  it('sends -2 for the unsubscribe filter, proving the two are no longer swapped', async () => {
    const { fetchStub, bodies } = serveAndCaptureRequest([])
    vi.stubGlobal('fetch', fetchStub)

    const { client } = createFakeSupabase()

    await pollInstantlyLeadStatus(
      client,
      'test-key',
      INSTANTLY_LEAD_STATUS_UNSUBSCRIBED,
      'lead_unsubscribed'
    )

    expect(bodies[0].status).toBe(-2)
  })
})
