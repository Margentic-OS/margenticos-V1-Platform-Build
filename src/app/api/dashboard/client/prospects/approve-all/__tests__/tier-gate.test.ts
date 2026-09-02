// approve-all is a send-path consumer even though it sends nothing.
//
// It is what moves a prospect to client_review_status = 'approved', which is one of the
// seven conditions the send gate checks. Approving a prospect tiering rejected walks it
// right up to that gate and leaves a single clause standing between it and the outbound
// provider. That is the shape CLAUDE.md records for verification_calls: one layer holding,
// nothing behind it.
//
// The fake honours the update's WHERE clause rather than recording that a call happened,
// because "the route ran" is not the question. The question is which rows it changed.
//
// It also covers the review-status filter, added 2026-09-01. Every fixture below used to
// sit at 'pending_review', so the case that actually mattered was never exercised: an
// unreviewed prospect is at NULL, and the route's `.in([null, 'pending_review'])` matched
// none of them. Measured on the live organisation before the fix, 100 rows at NULL and 0 at
// 'pending_review', selected 0.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TIER_NOT_REJECTED_FILTER } from '@/lib/sourcing/tier-verdict'
import { UNREVIEWED_FILTER } from '@/lib/sourcing/client-review-status'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

const ORG = 'org-approve-all'

interface Row {
  id: string
  organisation_id: string
  client_review_status: string | null
  sourced_tier: string | null
  tiering_reason: string | null
  // Tracked so "was this row touched" is answerable for a row that was ALREADY 'approved'.
  // Asserting its status is still 'approved' is tautological; asserting it never got a
  // stamp is not.
  client_review_auto_approved_at?: string | null
}

let rows: Row[] = []

/** sourced_tier IS NOT NULL OR tiering_reason IS NULL. */
const notRejected = (r: Row) => r.sourced_tier !== null || r.tiering_reason === null

/** client_review_status IS NULL OR client_review_status = 'pending_review'. */
const unreviewed = (r: Row) => r.client_review_status === null || r.client_review_status === 'pending_review'

function adminClient() {
  return {
    from(table: string) {
      if (table !== 'prospects') throw new Error(`fake does not implement table ${table}`)
      return {
        update(patch: Record<string, unknown>) {
          const eqs: Array<[string, unknown]> = []
          let notInIds: string[] = []
          const orFilters: string[] = []

          const builder: Record<string, unknown> = {
            eq: (c: string, v: unknown) => { eqs.push([c, v]); return builder },
            // Honoured by THROWING. The route used to filter the review status with
            // `.in('client_review_status', [null, 'pending_review'])`, which matched zero
            // rows because SQL IN never matches NULL. A fake that quietly accepted .in()
            // and applied JavaScript equality would have passed against the broken route,
            // which is exactly the shape CLAUDE.md records: the production code was wrong
            // and the fake was structurally incapable of noticing.
            in: (c: string) => {
              throw new Error(
                `fake: .in('${c}') is not implemented. SQL IN never matches NULL, so the ` +
                'review-status filter must be an IS NULL OR equality form.',
              )
            },
            // HONOURED, not swallowed. The whole point of this test is the WHERE clause.
            // Both or-filters are collected. PostgREST sends repeated `or=` params and ANDs
            // them at the top level, verified live 2026-09-01 against the real endpoint in
            // both orders, so the two groups compose as AND-of-ORs and the fake matches that.
            or: (expr: string) => { orFilters.push(expr); return builder },
            filter: (c: string, op: string, v: string) => {
              if (c === 'id' && op === 'not.in') {
                notInIds = v.replace(/^\(|\)$/g, '').split(',').filter(Boolean)
              }
              return builder
            },
            then: (resolve: (v: unknown) => void) => {
              const tierGated = orFilters.includes(TIER_NOT_REJECTED_FILTER)
              const reviewGated = orFilters.includes(UNREVIEWED_FILTER)
              for (const r of rows) {
                const matches =
                  eqs.every(([c, v]) => (r as unknown as Record<string, unknown>)[c] === v) &&
                  !notInIds.includes(r.id) &&
                  (!tierGated || notRejected(r)) &&
                  (!reviewGated || unreviewed(r))
                if (matches) Object.assign(r, patch)
              }
              resolve({ data: null, error: null })
            },
          }
          return builder
        },
      }
    },
  }
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'client-user' } } }) },
    from: (table: string) => {
      if (table !== 'users') throw new Error(`session fake does not implement ${table}`)
      return {
        select: () => ({
          eq: () => ({ single: async () => ({ data: { organisation_id: ORG }, error: null }) }),
        }),
      }
    },
  })),
}))

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => adminClient()) }))

import { POST } from '../route'

/**
 * A rejection reason, deliberately NOT one of the real ones.
 *
 * The gate is on the PRESENCE of a reason, never on what it says, and a fixture carrying a
 * real reason string would read as though the value mattered. It also would not catch the
 * legacy value already in the live data that REMOVAL_REASONS no longer lists.
 */
const A_REJECTION = 'a-rejection-reason-the-gate-never-reads'


const request = (body: unknown) => ({ json: async () => body }) as Request

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.invalid'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key-for-the-fake'
  rows = [
    { id: 'qualified', organisation_id: ORG, client_review_status: 'pending_review', sourced_tier: 'tier_1', tiering_reason: 'tier_1 (score 90)' },
    { id: 'rejected',  organisation_id: ORG, client_review_status: 'pending_review', sourced_tier: null, tiering_reason: A_REJECTION },
    { id: 'pending',   organisation_id: ORG, client_review_status: 'pending_review', sourced_tier: null, tiering_reason: null },
    // NULL is where an unreviewed prospect actually sits. The column has no default and
    // nothing writes 'pending_review' on the way in, so on live data these are the ONLY
    // shape that exists. The three rows above are the shape the old test assumed.
    { id: 'null-qualified', organisation_id: ORG, client_review_status: null, sourced_tier: 'tier_1', tiering_reason: 'tier_1 (score 90)' },
    { id: 'null-rejected',  organisation_id: ORG, client_review_status: null, sourced_tier: null, tiering_reason: A_REJECTION },
    // Already decided. Must not be dragged back through approval by the widened filter.
    { id: 'already-approved', organisation_id: ORG, client_review_status: 'approved', sourced_tier: 'tier_1', tiering_reason: 'tier_1 (score 90)', client_review_auto_approved_at: null },
    { id: 'removed-by-client', organisation_id: ORG, client_review_status: 'removed', sourced_tier: 'tier_1', tiering_reason: 'tier_1 (score 90)' },
  ]
  vi.clearAllMocks()
})

const statusOf = (id: string) => rows.find(r => r.id === id)!.client_review_status
const stampOf  = (id: string) => rows.find(r => r.id === id)!.client_review_auto_approved_at ?? null

describe('approve-all — the tier gate', () => {
  it('never approves a prospect tiering rejected', async () => {
    await POST(request({ removed_prospect_ids: [] }))

    expect(statusOf('qualified')).toBe('approved')
    // The assertion this file exists for.
    expect(statusOf('rejected')).toBe('pending_review')
  })

  it('still approves a prospect tiering has not reached yet', async () => {
    // excludeTierRejected, not requireTierPresent, matching every other upstream consumer.
    // The send gate refuses a pending prospect on its own until a tier exists, so holding
    // the approval back as well would strand a prospect that is simply waiting.
    await POST(request({ removed_prospect_ids: [] }))

    expect(statusOf('pending')).toBe('approved')
  })

  it('the client-supplied removal list still applies', async () => {
    // Proves the tier gate did not displace the existing filter it sits beside.
    await POST(request({ removed_prospect_ids: ['qualified'] }))

    expect(statusOf('qualified')).toBe('pending_review')
  })
})

describe('approve-all — the review-status filter', () => {
  it('approves a prospect whose review status is NULL', async () => {
    // THE ASSERTION THIS BLOCK EXISTS FOR. `.in([null, 'pending_review'])` matched zero
    // rows here, and an UPDATE matching zero rows returns error: null, so the route
    // answered ok:true while changing nothing.
    await POST(request({ removed_prospect_ids: [] }))

    expect(statusOf('null-qualified')).toBe('approved')
  })

  it('still approves a prospect explicitly at pending_review', async () => {
    await POST(request({ removed_prospect_ids: [] }))

    expect(statusOf('qualified')).toBe('approved')
  })

  it('the tier gate still refuses a rejected prospect sitting at NULL', async () => {
    // Widening the review filter must not widen the tier gate with it. This row is
    // reachable only now that NULL is selected at all, so before the fix the tier gate
    // was never asked about it.
    await POST(request({ removed_prospect_ids: [] }))

    expect(statusOf('null-rejected')).toBeNull()
  })

  it('never re-touches a prospect already decided', async () => {
    await POST(request({ removed_prospect_ids: [] }))

    expect(statusOf('removed-by-client')).toBe('removed')
    // The status assertion alone would be tautological on a row that was already
    // 'approved'. The stamp is what says the UPDATE did not reach it.
    expect(statusOf('already-approved')).toBe('approved')
    expect(stampOf('already-approved')).toBeNull()
  })
})
