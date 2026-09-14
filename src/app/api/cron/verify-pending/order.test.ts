// FREE BEFORE PAID: THE SWEEP TIERS, THEN VERIFIES.
//
// Tiering removes prospects on staff count, industry, the client's buyer criterion and a
// plainly held second job, all deterministic reads of data enrichment already bought.
// Verification spends a finite daily budget, shared across every organisation, one probe per
// address. Run in the other order, which is how this ran until 2026-09-14, the budget goes on
// prospects tiering is about to reject: measured 2026-09-01, 15 rejected rows in the live
// organisation had all been verified first.
//
// Both stages are mocked here, because the only thing under test is the ORDER and what
// happens when the free one fails.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const calls = vi.hoisted(() => ({ order: [] as string[], tierThrows: { value: false } }))

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@sentry/nextjs', () => ({ captureCheckIn: vi.fn(() => 'checkin-id'), flush: vi.fn(() => Promise.resolve()) }))

vi.mock('@/lib/sourcing/tiering-trigger', () => ({
  tierEnrichedBatch: vi.fn(async () => {
    calls.order.push('tier')
    if (calls.tierThrows.value) throw new Error('no approved ICP filter spec found')
    return { organisation_id: 'org-1', prospects_classified: 3, tier_1_count: 2, tier_2_count: 0, tier_3_count: 0, untiered_count: 1, timestamp: '' }
  }),
}))

vi.mock('@/lib/sourcing/verification-trigger', () => ({
  DEFAULT_VERIFY_BATCH_SIZE: 40,
  MAX_RETRY_ATTEMPTS: 3,
  verifyEnrichedBatch: vi.fn(async () => {
    calls.order.push('verify')
    return {
      organisation_id: 'org-1', batch_size: 1, total_verified: 1, send_eligible_count: 1,
      not_send_eligible_count: 0, grey_listed_retry_count: 0, failed_count: 0,
      verified_at: new Date().toISOString(), status: 'success' as const, daily_verifications_used: 1,
    }
  }),
}))

/** Answers every read with one organisation awaiting verification, and accepts every write. */
vi.mock('@supabase/supabase-js', () => {
  const chain: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'or', 'is', 'not', 'in', 'lt', 'gte', 'order', 'limit', 'update', 'insert', 'upsert']) {
    chain[method] = () => chain
  }
  chain.single = async () => ({ data: { organisation_id: 'org-1' }, error: null })
  chain.maybeSingle = async () => ({ data: { organisation_id: 'org-1' }, error: null })
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: [{ organisation_id: 'org-1' }], error: null, count: 1 }).then(resolve)
  return { createClient: vi.fn(() => ({ from: () => chain })) }
})

const { POST } = await import('./route')

const request = () =>
  new NextRequest('http://localhost/api/cron/verify-pending', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  })

beforeEach(() => {
  calls.order = []
  calls.tierThrows.value = false
  vi.stubEnv('CRON_SECRET', 'test-secret')
  process.env.CRON_SECRET = 'test-secret'
})

describe('the sweep runs the free stage before the paid one', () => {
  it('tiers first, then verifies', async () => {
    await POST(request())
    expect(calls.order).toEqual(['tier', 'verify'])
  })

  it('verifies anyway when tiering fails, because a missing spec is not a reason to stop', async () => {
    calls.tierThrows.value = true
    await POST(request())
    expect(calls.order).toEqual(['tier', 'verify'])
  })
})
