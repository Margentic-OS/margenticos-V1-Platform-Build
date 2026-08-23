// src/lib/sourcing/enrichment-credit-guard.test.ts
//
// Regression tests for the Apollo credit re-spend loop measured on 2026-08-10:
// 303 enrichments requested across 12 runs against the same ~29 people, 141 credits,
// 4.86 per prospect, against Apollo's ceiling of 1 credit per contact.
//
// These are behavioural, not structural. The fake Supabase below holds a real in-memory
// prospects table and actually applies eq / in / is / not predicates to it, so every
// assertion reads the row state the code produced rather than counting mock calls. A test
// that only asserted "update was called with held_incomplete" would still pass if the
// filters were wrong and the write landed on nobody.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { enrichProspectsForOrganisation } from './handlers/adapter-apollo-enrichment'
import { enrichApprovedBatch } from './enrichment-trigger'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// Live mode. The mock-enrichment path returns credits_consumed: 0 and never calls Apollo,
// which is the opposite of what these tests are about.
vi.mock('@/lib/sourcing/enrichment-mode', () => ({
  shouldUseMockEnrichment: vi.fn().mockResolvedValue(false),
}))

// Dedupe is a separate concern with its own tests. Clean verdict keeps the focus on status
// and credit bookkeeping.
vi.mock('@/lib/sourcing/dedupe-verdict', () => ({
  getDedupeVerdict: vi.fn().mockResolvedValue('new'),
}))

const ORG = '00000000-0000-4000-8000-00000000org1'

interface ProspectRow {
  id: string
  organisation_id: string
  source_person_key: string
  sourcing_review_status: string
  enrichment_status: string | null
  enrichment_credit_consumed_at: string | null
  enrichment_locked_at: string | null
  last_name: string | null
  email: string | null
  [k: string]: unknown
}

function prospect(n: number, over: Partial<ProspectRow> = {}): ProspectRow {
  return {
    id: `p${n}`,
    organisation_id: ORG,
    source_person_key: `apollo:a${n}`,
    sourcing_review_status: 'approved',
    enrichment_status: null,
    enrichment_credit_consumed_at: null,
    enrichment_locked_at: null,
    last_name: null,
    email: null,
    ...over,
  }
}

type Filter = (row: ProspectRow) => boolean

/**
 * In-memory Supabase double. Applies predicates for real; UPDATE mutates the store.
 * Only the surface this code path touches is implemented.
 */
function makeDb(rows: ProspectRow[]) {
  const store = { prospects: rows, enrichment_runs: [] as Record<string, unknown>[] }

  function builder(table: string) {
    const filters: Filter[] = []
    let mode: 'select' | 'update' | 'insert' = 'select'
    let payload: Record<string, unknown> = {}

    const matched = () =>
      (store[table as keyof typeof store] as ProspectRow[]).filter(r => filters.every(f => f(r)))

    const apply = () => {
      if (mode === 'update') {
        for (const row of matched()) Object.assign(row, payload)
      }
      return { data: matched(), error: null }
    }

    const chain: Record<string, unknown> = {
      select() { mode = 'select'; return chain },
      update(p: Record<string, unknown>) { mode = 'update'; payload = p; return chain },
      insert(p: Record<string, unknown>) {
        mode = 'insert'
        store.enrichment_runs.push(p)
        return Promise.resolve({ data: null, error: null })
      },
      eq(col: string, val: unknown) { filters.push(r => r[col] === val); return chain },
      in(col: string, vals: unknown[]) { filters.push(r => vals.includes(r[col])); return chain },
      is(col: string, val: null) { filters.push(r => r[col] === val); return chain },
      not(col: string, _op: string, _val: null) { filters.push(r => r[col] !== null); return chain },
      or(expr: string) {
        // Only the stale-lock expression is used here:
        // "enrichment_locked_at.is.null,enrichment_locked_at.lt.<iso>"
        const iso = expr.split('enrichment_locked_at.lt.')[1]
        filters.push(r =>
          r.enrichment_locked_at === null || (iso !== undefined && r.enrichment_locked_at! < iso))
        return chain
      },
      order() { return chain },
      limit() { return chain },
      single() {
        const m = matched()
        return Promise.resolve(
          m.length === 1 ? { data: m[0], error: null } : { data: null, error: { message: 'not found' } })
      },
      maybeSingle() { return Promise.resolve({ data: matched()[0] ?? null, error: null }) },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve(apply()).then(resolve) },
    }
    return chain
  }

  return { client: { from: (t: string) => builder(t) } as never, store }
}

function apolloResponse(over: Record<string, unknown> = {}) {
  return {
    status: 'success',
    error_code: null,
    error_message: null,
    total_requested_enrichments: 2,
    unique_enriched_records: 2,
    missing_records: 0,
    credits_consumed: 2,
    matches: [
      { id: 'a1', first_name: 'A', last_name: 'One', email: 'a1@x.com', email_status: 'verified',
        linkedin_url: null, title: 'Founder', organization: { name: 'X', primary_domain: 'x.com',
          estimated_num_employees: 9, industry: 'Management Consulting' } },
      { id: 'a2', first_name: 'B', last_name: 'Two', email: 'a2@x.com', email_status: 'verified',
        linkedin_url: null, title: 'Founder', organization: { name: 'Y', primary_domain: 'y.com',
          estimated_num_employees: 8, industry: 'Management Consulting' } },
    ],
    ...over,
  }
}

function mockFetch(body: Record<string, unknown>) {
  return vi.fn().mockResolvedValue({
    ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body),
  })
}

beforeEach(() => { process.env.APOLLO_API_KEY = 'test-key' })
afterEach(() => { vi.restoreAllMocks() })

describe('recordBatchSpend: terminal status floor', () => {
  it('leaves every prospect terminal when the Apollo-id mapping step finds nobody', async () => {
    // The Aug 10 suspect: Apollo answers with its own canonical person ids, none of which
    // match the source_person_key values we sent, so keyToProspectId misses on every match
    // and the refinement loop `continue`s past all of them. Before the floor, that ended
    // with the credit spent and enrichment_status still NULL on both rows.
    const rows = [prospect(1), prospect(2)]
    const { client, store } = makeDb(rows)
    vi.stubGlobal('fetch', mockFetch(apolloResponse({
      matches: [
        { id: 'CANONICAL-9', email: 'a1@x.com', email_status: 'verified', organization: null },
        { id: 'CANONICAL-8', email: 'a2@x.com', email_status: 'verified', organization: null },
      ],
    })))

    const run = await enrichProspectsForOrganisation(client, ORG, ['a1', 'a2'], 100)

    expect(run.credits_consumed).toBe(2)
    // The requirement is TERMINAL, not one specific value. A key Apollo never echoed back
    // legitimately settles at held_missing; the floor's job is that nothing is left NULL
    // once the money is gone, because NULL is the state the stale-lock reclaim re-buys.
    const TERMINAL = ['held_incomplete', 'held_missing', 'held_duplicate', 'held_no_email',
                      'held_unverified', 'enriched']
    for (const row of store.prospects) {
      expect(row.enrichment_status).not.toBeNull()
      expect(TERMINAL).toContain(row.enrichment_status)
      // And the receipt is on the row, so the reclaim cannot buy this person a second time.
      expect(row.enrichment_credit_consumed_at).not.toBeNull()
    }
  })

  it('does not downgrade a verdict an earlier run already reached', async () => {
    // The floor is scoped .is('enrichment_status', null). A prospect that already reads
    // 'enriched' must survive a later batch that includes it.
    const rows = [prospect(1, { enrichment_status: 'enriched' }), prospect(2)]
    const { client, store } = makeDb(rows)
    vi.stubGlobal('fetch', mockFetch(apolloResponse({
      matches: [{ id: 'CANONICAL-9', email: 'z@x.com', email_status: 'verified', organization: null }],
      credits_consumed: 1,
    })))

    await enrichProspectsForOrganisation(client, ORG, ['a1', 'a2'], 100)

    expect(store.prospects.find(r => r.id === 'p1')!.enrichment_status).toBe('enriched')
  })

  it('still refines the floor to the real verdict when mapping succeeds', async () => {
    // The floor must not become the resting state on the happy path.
    const rows = [prospect(1), prospect(2)]
    const { client, store } = makeDb(rows)
    vi.stubGlobal('fetch', mockFetch(apolloResponse()))

    await enrichProspectsForOrganisation(client, ORG, ['a1', 'a2'], 100)

    for (const row of store.prospects) {
      expect(row.enrichment_status).toBe('enriched')
      expect(row.email).toMatch(/@x\.com$/)
    }
  })
})

describe('recordBatchSpend: per-prospect credit stamp', () => {
  it('stamps every prospect in a batch Apollo charged for', async () => {
    const rows = [prospect(1), prospect(2)]
    const { client, store } = makeDb(rows)
    vi.stubGlobal('fetch', mockFetch(apolloResponse()))

    await enrichProspectsForOrganisation(client, ORG, ['a1', 'a2'], 100)

    for (const row of store.prospects) {
      expect(row.enrichment_credit_consumed_at).not.toBeNull()
    }
  })

  it('does not stamp a free repeat match', async () => {
    // Observed on Aug 10: runs 2, 3 and 4 re-sent the same 25 people and Apollo returned
    // credits_consumed 0 each time. Nothing was bought, so nothing is recorded as bought.
    const rows = [prospect(1), prospect(2)]
    const { client, store } = makeDb(rows)
    vi.stubGlobal('fetch', mockFetch(apolloResponse({ credits_consumed: 0 })))

    await enrichProspectsForOrganisation(client, ORG, ['a1', 'a2'], 100)

    for (const row of store.prospects) {
      expect(row.enrichment_credit_consumed_at).toBeNull()
    }
  })
})

describe('enrichApprovedBatch: the stale-lock reclaim respects the credit stamp', () => {
  it('does not re-select a prospect we have already paid for', async () => {
    // The exact Aug 10 shape: a handler died after the response returned, so the lock is
    // 31 minutes old and enrichment_status is still NULL. The reclaim used to buy this
    // person again because it only ever asked about the lock.
    const stale = new Date(Date.now() - 31 * 60 * 1000).toISOString()
    const paid = prospect(1, { enrichment_locked_at: stale, enrichment_credit_consumed_at: '2026-08-10T17:27:53Z' })
    const unpaid = prospect(2, { enrichment_locked_at: stale })
    const { client } = makeDb([paid, unpaid])
    vi.stubGlobal('fetch', mockFetch(apolloResponse({
      matches: [{ id: 'a2', email: 'a2@x.com', email_status: 'verified', organization: null }],
      credits_consumed: 1, total_requested_enrichments: 1, unique_enriched_records: 1,
    })))

    const run = await enrichApprovedBatch(client, ORG, 100)

    // Only the never-paid-for prospect reaches Apollo.
    expect(run.batch_size).toBe(1)
    const sent = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
    expect(sent.details).toEqual([{ id: 'a2' }])
  })

  it('makes no Apollo call at all when every candidate is already paid for', async () => {
    const stale = new Date(Date.now() - 31 * 60 * 1000).toISOString()
    const { client } = makeDb([
      prospect(1, { enrichment_locked_at: stale, enrichment_credit_consumed_at: '2026-08-10T17:27:53Z' }),
      prospect(2, { enrichment_locked_at: stale, enrichment_credit_consumed_at: '2026-08-10T20:40:48Z' }),
    ])
    const fetchSpy = mockFetch(apolloResponse())
    vi.stubGlobal('fetch', fetchSpy)

    const run = await enrichApprovedBatch(client, ORG, 100)

    expect(run.batch_size).toBe(0)
    expect(run.credits_consumed).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
