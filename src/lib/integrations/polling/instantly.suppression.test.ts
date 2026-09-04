// Tests for the WIRING between bounce/unsubscribe detection and the global
// suppression list. Audit finding D2: detection was correct as of fcb2f94 and fed
// nothing, so a bounce wrote a signals row that no send path ever read.
//
// These drive the real pollInstantlyLeadStatus against real HTTP responses and assert
// on the suppressed_emails rows the production code actually wrote. A test that only
// checked the signal row would not have caught D2 — that is exactly what was passing
// while the gate did not exist.

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

interface SuppressionRow {
  email: string
  reason: string
  source_org_id: string | null
  source_signal_id: string | null
  revoked_at: string | null
}

// Fake Supabase serving campaigns, polling_cursors, signals and suppressed_emails.
// signals and suppressed_emails both enforce their real unique constraints, so
// idempotency is actually exercised rather than assumed.
function createFakeSupabase(campaigns: FakeCampaign[] = [CAMPAIGN]) {
  const signalInserts: Record<string, unknown>[] = []
  const suppressionRows: SuppressionRow[] = []
  const seenSignalKeys = new Set<string>()
  let nextSignalId = 1

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
          upsert: async () => ({ error: null }),
        }
        return builder
      }

      if (table === 'signals') {
        return {
          insert: (row: Record<string, unknown>) => ({
            select: async (_cols: string) => {
              // Mirrors idx_signals_idempotency on
              // (organisation_id, source, external_event_id).
              const key = `${row.organisation_id}|${row.source}|${row.external_event_id}`
              if (seenSignalKeys.has(key)) {
                return { data: null, error: { code: '23505', message: 'idx_signals_idempotency' } }
              }
              seenSignalKeys.add(key)
              signalInserts.push(row)
              return { data: [{ id: `signal-${nextSignalId++}` }], error: null }
            },
          }),
        }
      }

      if (table === 'suppressed_emails') {
        return {
          insert: async (row: Record<string, unknown>) => {
            const email = row.email as string
            // CHECK (email = lower(btrim(email)))
            if (email !== email.trim().toLowerCase()) {
              return { error: { code: '23514', message: 'suppressed_emails_email_normalised' } }
            }
            // UNIQUE (email) WHERE revoked_at IS NULL
            if (suppressionRows.some(r => r.email === email && r.revoked_at === null)) {
              return { error: { code: '23505', message: 'suppressed_emails_active_unique' } }
            }
            // A write failure the production code treats as 'error' rather than as
            // idempotency. Addressed by a sentinel local part because the real CHECK
            // violation is unreachable from here: recordSuppression normalises before
            // inserting, so no fixture address can trigger it.
            if (email.startsWith('write-fails@')) {
              return { error: { code: '23503', message: 'suppressed_emails_source_signal_id_fkey' } }
            }
            suppressionRows.push({
              email,
              reason: row.reason as string,
              source_org_id: (row.source_org_id as string) ?? null,
              source_signal_id: (row.source_signal_id as string) ?? null,
              revoked_at: null,
            })
            return { error: null }
          },
        }
      }

      throw new Error(`unexpected table ${table}`)
    },
  }

  return { client, signalInserts, suppressionRows }
}

// Serves one page of leads then an empty page, matching Instantly's { items, pagination }.
function serveLeads(leads: Record<string, unknown>[]) {
  let call = 0
  return vi.fn(async () => {
    call++
    const body = call === 1 ? { items: leads, pagination: {} } : { items: [], pagination: {} }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
}

const originalFetch = globalThis.fetch
const originalApiActive = process.env.INSTANTLY_API_ACTIVE

beforeEach(() => {
  // Real HTTP path, not the in-process mock dispatch, so the poller's own request and
  // response handling is under test.
  process.env.INSTANTLY_API_ACTIVE = 'true'
  carryOneSuppression.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  globalThis.fetch = originalFetch
  if (originalApiActive === undefined) delete process.env.INSTANTLY_API_ACTIVE
  else process.env.INSTANTLY_API_ACTIVE = originalApiActive
})

describe('bounce and unsubscribe wiring to the suppression list', () => {
  it('a bounce signal inserts a suppression carrying reason, org and signal id', async () => {
    const { client, signalInserts, suppressionRows } = createFakeSupabase()
    vi.stubGlobal('fetch', serveLeads([{ id: 'lead-1', email: 'bounced@x.com', status: -1 }]))

    const result = await pollInstantlyLeadStatus(
      client, 'test-key', INSTANTLY_LEAD_STATUS_BOUNCED, 'email_bounced'
    )

    expect(result.written).toBe(1)
    expect(result.errors).toBe(0)
    expect(signalInserts).toHaveLength(1)

    // The part D2 was missing.
    expect(suppressionRows).toHaveLength(1)
    expect(suppressionRows[0].email).toBe('bounced@x.com')
    expect(suppressionRows[0].reason).toBe('bounced')
    expect(suppressionRows[0].source_org_id).toBe('org-a')
    expect(suppressionRows[0].source_signal_id).toBe('signal-1')
  })

  it('an unsubscribe signal inserts a suppression with reason unsubscribed', async () => {
    const { client, suppressionRows } = createFakeSupabase()
    vi.stubGlobal('fetch', serveLeads([{ id: 'lead-2', email: 'unsub@x.com', status: -2 }]))

    await pollInstantlyLeadStatus(
      client, 'test-key', INSTANTLY_LEAD_STATUS_UNSUBSCRIBED, 'lead_unsubscribed'
    )

    expect(suppressionRows).toHaveLength(1)
    expect(suppressionRows[0].email).toBe('unsub@x.com')
    expect(suppressionRows[0].reason).toBe('unsubscribed')
  })

  it('normalises the address Instantly returns before storing it', async () => {
    const { client, suppressionRows } = createFakeSupabase()
    vi.stubGlobal('fetch', serveLeads([{ id: 'lead-3', email: '  Bob@X.COM ', status: -1 }]))

    await pollInstantlyLeadStatus(
      client, 'test-key', INSTANTLY_LEAD_STATUS_BOUNCED, 'email_bounced'
    )

    expect(suppressionRows).toHaveLength(1)
    expect(suppressionRows[0].email).toBe('bob@x.com')
  })

  it('the same signal arriving twice does not duplicate the suppression', async () => {
    // The full-scan resources re-return every bounced lead on every poll, so this is
    // the normal case on every run after the first, not an edge case.
    const { client, signalInserts, suppressionRows } = createFakeSupabase()

    vi.stubGlobal('fetch', serveLeads([{ id: 'lead-4', email: 'repeat@x.com', status: -1 }]))
    const first = await pollInstantlyLeadStatus(
      client, 'test-key', INSTANTLY_LEAD_STATUS_BOUNCED, 'email_bounced'
    )

    vi.stubGlobal('fetch', serveLeads([{ id: 'lead-4', email: 'repeat@x.com', status: -1 }]))
    const second = await pollInstantlyLeadStatus(
      client, 'test-key', INSTANTLY_LEAD_STATUS_BOUNCED, 'email_bounced'
    )

    expect(first.written).toBe(1)
    expect(second.written).toBe(0)
    expect(second.skipped).toBe(1)   // signal idempotency fired
    expect(second.errors).toBe(0)    // and that is not an error
    expect(signalInserts).toHaveLength(1)
    expect(suppressionRows).toHaveLength(1)
  })

  it('suppresses on a skipped signal too, so signals written before this wiring are covered', async () => {
    // A signal already in the table from an earlier poll must still produce a
    // suppression. Without this, every bounce recorded before today stays unenforced.
    const { client, suppressionRows } = createFakeSupabase()

    // Pre-seed the signal only, as if the poller had run before the wiring existed.
    await client.from('signals').insert({
      organisation_id: 'org-a', source: 'instantly', external_event_id: 'lead-5',
    }).select('id')
    expect(suppressionRows).toHaveLength(0)

    vi.stubGlobal('fetch', serveLeads([{ id: 'lead-5', email: 'preexisting@x.com', status: -1 }]))
    const result = await pollInstantlyLeadStatus(
      client, 'test-key', INSTANTLY_LEAD_STATUS_BOUNCED, 'email_bounced'
    )

    expect(result.skipped).toBe(1)
    expect(suppressionRows).toHaveLength(1)
    expect(suppressionRows[0].email).toBe('preexisting@x.com')
    // No signal id available on a conflicting insert, hence the nullable column.
    expect(suppressionRows[0].source_signal_id).toBeNull()
  })

  it('does not suppress a lead whose status fails the read-back check', async () => {
    // A lead returned by a bounced query that does not carry status -1 is a broken poll.
    // It must not write a signal, and it must not suppress an address either.
    const { client, signalInserts, suppressionRows } = createFakeSupabase()
    vi.stubGlobal('fetch', serveLeads([{ id: 'lead-6', email: 'active@x.com', status: 1 }]))

    const result = await pollInstantlyLeadStatus(
      client, 'test-key', INSTANTLY_LEAD_STATUS_BOUNCED, 'email_bounced'
    )

    expect(signalInserts).toHaveLength(0)
    expect(suppressionRows).toHaveLength(0)
    expect(result.errors).toBeGreaterThan(0)
  })

  it('reports an error when a bounced lead has no address to suppress', async () => {
    const { client, signalInserts, suppressionRows } = createFakeSupabase()
    vi.stubGlobal('fetch', serveLeads([{ id: 'lead-7', status: -1 }]))

    const result = await pollInstantlyLeadStatus(
      client, 'test-key', INSTANTLY_LEAD_STATUS_BOUNCED, 'email_bounced'
    )

    // The signal still lands — the bounce happened and the record should exist.
    expect(signalInserts).toHaveLength(1)
    // But there is nothing to suppress, and that is loud rather than silent.
    expect(suppressionRows).toHaveLength(0)
    expect(result.errors).toBeGreaterThan(0)
  })

  it('records one suppression per distinct bounced address across a page', async () => {
    const { client, suppressionRows } = createFakeSupabase()
    vi.stubGlobal('fetch', serveLeads([
      { id: 'lead-8', email: 'one@x.com', status: -1 },
      { id: 'lead-9', email: 'two@x.com', status: -1 },
      // Same human, different lead row and different capitalisation.
      { id: 'lead-10', email: 'ONE@X.COM', status: -1 },
    ]))

    const result = await pollInstantlyLeadStatus(
      client, 'test-key', INSTANTLY_LEAD_STATUS_BOUNCED, 'email_bounced'
    )

    expect(result.written).toBe(3)      // three distinct leads, three signals
    expect(suppressionRows).toHaveLength(2)  // two distinct addresses
    expect(suppressionRows.map(r => r.email).sort()).toEqual(['one@x.com', 'two@x.com'])
    expect(result.errors).toBe(0)       // the duplicate address is not an error
  })

  // ── THE PROVIDER HALF OF THE GLOBAL STORE ──────────────────────────────────
  //
  // suppressed_emails is GLOBAL and keyed by address alone. The provider told us about the
  // bounce, so it has already stopped ITS OWN lead, the one this poll is reading. It has
  // NOT stopped the same address sitting in another client's campaign in the same shared
  // workspace, and nothing else in this system would.
  //
  // Measured on the day this was written: one address on the global list, active, and its
  // lead row still present at the provider.

  it('carries every newly suppressed address out to the provider', async () => {
    const { client } = createFakeSupabase()
    vi.stubGlobal('fetch', serveLeads([{ id: 'lead-1', email: 'bounced@x.com', status: -1 }]))

    await pollInstantlyLeadStatus(client, 'test-key', INSTANTLY_LEAD_STATUS_BOUNCED, 'email_bounced')

    expect(carryOneSuppression).toHaveBeenCalledTimes(1)
    expect(carryOneSuppression).toHaveBeenCalledWith(client, {
      email: 'bounced@x.com',
      organisationId: 'org-a',
    })
  })

  it('carries the address on a REPEAT signal too, when suppression was already recorded', async () => {
    // 'already_suppressed' is the normal case on every full scan after the first, and it is
    // exactly when a NEW duplicate lead for an old suppressed address would be found. A
    // provider call gated on 'recorded' only would never fire again after day one.
    const { client } = createFakeSupabase()
    const lead = { id: 'lead-1', email: 'bounced@x.com', status: -1 }

    // A FRESH stub per poll. serveLeads carries page state, so one stub reused across two
    // polls serves an exhausted page the second time and the run reads as "no leads",
    // which would make this test pass or fail for a reason unrelated to its subject.
    vi.stubGlobal('fetch', serveLeads([lead]))
    await pollInstantlyLeadStatus(client, 'test-key', INSTANTLY_LEAD_STATUS_BOUNCED, 'email_bounced')
    carryOneSuppression.mockClear()

    vi.stubGlobal('fetch', serveLeads([lead]))
    const second = await pollInstantlyLeadStatus(client, 'test-key', INSTANTLY_LEAD_STATUS_BOUNCED, 'email_bounced')

    // Confirm the second run really did see the lead again and hit signal idempotency,
    // rather than finding nothing to do.
    expect(second.skipped).toBe(1)

    expect(carryOneSuppression).toHaveBeenCalledTimes(1)
  })

  it('does NOT call the provider when the suppression row could not be written', async () => {
    // If the row the send gate reads does not exist, the poll has failed. Telling the
    // provider anyway would leave the two sides disagreeing in the direction where our
    // record says a person may be mailed.
    const { client } = createFakeSupabase()
    vi.stubGlobal('fetch', serveLeads([{ id: 'lead-1', email: 'write-fails@x.com', status: -1 }]))

    const result = await pollInstantlyLeadStatus(
      client, 'test-key', INSTANTLY_LEAD_STATUS_BOUNCED, 'email_bounced'
    )

    expect(result.errors).toBe(1)
    expect(carryOneSuppression).not.toHaveBeenCalled()
  })
})
