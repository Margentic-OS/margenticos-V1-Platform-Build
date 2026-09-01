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

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TIER_NOT_REJECTED_FILTER } from '@/lib/sourcing/tier-verdict'

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
}

let rows: Row[] = []

/** sourced_tier IS NOT NULL OR tiering_reason IS NULL. */
const notRejected = (r: Row) => r.sourced_tier !== null || r.tiering_reason === null

function adminClient() {
  return {
    from(table: string) {
      if (table !== 'prospects') throw new Error(`fake does not implement table ${table}`)
      return {
        update(patch: Record<string, unknown>) {
          const eqs: Array<[string, unknown]> = []
          let inList: unknown[] | null = null
          let notInIds: string[] = []
          const orFilters: string[] = []

          const builder: Record<string, unknown> = {
            eq: (c: string, v: unknown) => { eqs.push([c, v]); return builder },
            in: (_c: string, v: unknown[]) => { inList = v; return builder },
            // HONOURED, not swallowed. The whole point of this test is the WHERE clause.
            or: (expr: string) => { orFilters.push(expr); return builder },
            filter: (c: string, op: string, v: string) => {
              if (c === 'id' && op === 'not.in') {
                notInIds = v.replace(/^\(|\)$/g, '').split(',').filter(Boolean)
              }
              return builder
            },
            then: (resolve: (v: unknown) => void) => {
              const tierGated = orFilters.includes(TIER_NOT_REJECTED_FILTER)
              for (const r of rows) {
                const matches =
                  eqs.every(([c, v]) => (r as unknown as Record<string, unknown>)[c] === v) &&
                  // SQL IN semantics, which is what PostgREST generates and what the real
                  // route relies on. See the test below on the NULL rows.
                  (inList === null || inList.some(v => v !== null && v === r.client_review_status)) &&
                  !notInIds.includes(r.id) &&
                  (!tierGated || notRejected(r))
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
  ]
  vi.clearAllMocks()
})

const statusOf = (id: string) => rows.find(r => r.id === id)!.client_review_status

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
