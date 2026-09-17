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
  /** NULL means never published, which means the client was never shown it. */
  tier_published_at?: string | null
}

/** Any non-null timestamp. The gate reads presence, never the value. */
const PUBLISHED = '2026-09-16T20:58:29.305Z'

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
          const notNullColumns: string[] = []

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
            // HONOURED. Added 2026-09-16 with the publish gate. Only the IS NOT NULL form
            // is implemented, and anything else throws rather than being quietly ignored:
            // a fake that accepted `.not()` and applied nothing would pass against a route
            // with the clause deleted, which is the exact failure this file's `.in()` stub
            // was written to prevent.
            not: (c: string, op: string, v: unknown) => {
              if (op !== 'is' || v !== null) {
                throw new Error(`fake: .not('${c}', '${op}', ...) is not implemented`)
              }
              notNullColumns.push(c)
              return builder
            },
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
                  notNullColumns.every(c => (r as unknown as Record<string, unknown>)[c] != null) &&
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
  // EVERY fixture below carries tier_published_at unless the test is about not having it.
  // The tier gate and the review filter are what those tests isolate, and leaving them
  // unpublished would let the publish gate answer first and hide which clause did the work.
  rows = [
    { id: 'qualified', organisation_id: ORG, client_review_status: 'pending_review', sourced_tier: 'tier_1', tiering_reason: 'tier_1 (score 90)', tier_published_at: PUBLISHED },
    { id: 'rejected',  organisation_id: ORG, client_review_status: 'pending_review', sourced_tier: null, tiering_reason: A_REJECTION, tier_published_at: PUBLISHED },
    // Never tiered AND never published. Before 2026-09-16 this was approved on purpose;
    // it is now refused. See the test below for why that decision changed.
    { id: 'pending',   organisation_id: ORG, client_review_status: 'pending_review', sourced_tier: null, tiering_reason: null, tier_published_at: null },
    // NULL is where an unreviewed prospect actually sits. The column has no default and
    // nothing writes 'pending_review' on the way in, so on live data these are the ONLY
    // shape that exists. The three rows above are the shape the old test assumed.
    { id: 'null-qualified', organisation_id: ORG, client_review_status: null, sourced_tier: 'tier_1', tiering_reason: 'tier_1 (score 90)', tier_published_at: PUBLISHED },
    { id: 'null-rejected',  organisation_id: ORG, client_review_status: null, sourced_tier: null, tiering_reason: A_REJECTION, tier_published_at: PUBLISHED },
    // Already decided. Must not be dragged back through approval by the widened filter.
    { id: 'already-approved', organisation_id: ORG, client_review_status: 'approved', sourced_tier: 'tier_1', tiering_reason: 'tier_1 (score 90)', client_review_auto_approved_at: null, tier_published_at: PUBLISHED },
    { id: 'removed-by-client', organisation_id: ORG, client_review_status: 'removed', sourced_tier: 'tier_1', tiering_reason: 'tier_1 (score 90)', tier_published_at: PUBLISHED },
    // THE MUTATION PAIR for the publish gate. Identical to 'null-qualified' in every field
    // the other gates read — same tier, same reason, same review status. The ONLY
    // difference is tier_published_at. If the publish clause is deleted from the route,
    // these two become indistinguishable and the test below goes red.
    { id: 'unpublished-qualified', organisation_id: ORG, client_review_status: null, sourced_tier: 'tier_1', tiering_reason: 'tier_1 (score 90)', tier_published_at: null },
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

  it('no longer approves a prospect tiering has not reached yet, because it was never shown', async () => {
    // CHANGED 2026-09-16, and the reasoning it replaces is recorded rather than deleted.
    //
    // This used to assert 'approved'. The argument was that excludeTierRejected matches
    // every other upstream consumer, and that the send gate refuses an untiered prospect
    // on its own, so holding the approval back would strand one that is simply waiting.
    //
    // That argument is about TIER. It is silent on CONSENT, and consent is what this route
    // records. An untiered prospect has not been published, so it has never appeared on the
    // client's screen; approving it stores a decision the client never made.
    //
    // Measured on the live organisation 2026-09-16: an operator published 34, the client
    // approved once, and 80 rows moved. The 46 extra were unpublished and untiered.
    //
    // It is not stranded. When tiering reaches it and an operator publishes it, the client
    // sees it and can approve it then — which is the sequence the review screen exists to
    // enforce. The send gate still refuses it meanwhile, and that remains true; a second
    // gate catching this one's mistake was never a reason to leave this one wrong.
    await POST(request({ removed_prospect_ids: [] }))

    expect(statusOf('pending')).toBe('pending_review')
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

describe('approve-all — the publish gate', () => {
  it('MUTATION PROOF: a prospect that was never published is NOT approved', async () => {
    await POST(request({ removed_prospect_ids: [] }))

    // Identical to 'null-qualified' except tier_published_at. Delete the
    // .not('tier_published_at', 'is', null) clause from the route and this goes red.
    expect(statusOf('unpublished-qualified')).toBeNull()
    expect(stampOf('unpublished-qualified')).toBeNull()
  })

  it('MUTATION PROOF: a published prospect still is approved', async () => {
    await POST(request({ removed_prospect_ids: [] }))

    // The other half of the pair. Without this, a route that approved NOTHING would pass
    // the test above, which is the failure mode the review-status fix was written for:
    // an UPDATE matching zero rows returns error: null and reports success.
    expect(statusOf('null-qualified')).toBe('approved')
  })
})
