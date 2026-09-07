// The row cap on the PAID second-pass candidate read.
//
//   .limit(cappedBatchSize)          where cappedBatchSize = Math.min(maxBatchSize, dailyRemaining)
//
// Every row this read returns becomes a billed provider call, so the cap is the only thing
// between a caller asking for a batch of 2 and the query handing back the entire backlog.
//
// It was proven by nothing. second-pass-trigger-safety.test.ts states the gap in its own
// words at the batch-cap case: "The fake returns every row regardless of .limit(), so the
// in-run budget guard is what has to stop the spend." That is true and it is the reason the
// gap survived: the in-run guard covers the DAILY-BUDGET arm of the min(), so deleting
// .limit() still stops at the daily limit and every existing test stays green. Measured
// 2026-09-07 against 1be5f00: with .limit(cappedBatchSize) deleted, all 19 tests in
// second-pass-trigger-safety.test.ts and the verify-catch-all route passed.
//
// The arm nothing covers is the OTHER one: maxBatchSize smaller than the remaining budget.
// There the in-run guard never binds, because the run is nowhere near the daily limit, and
// .limit() is the sole constraint. That is what this file pins.
//
// It uses fakeProspectsClient, the strict stand-in, unchanged. That helper already honours
// .limit(), .or() including the tier gate and the stale-lock expression, .in(), .is(),
// .lt() and .not(), and throws on anything it was not taught, so no generalisation was
// needed to write these tests.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { runSecondPassBatch, SECOND_PASS_DAILY_CALL_LIMIT } from '../second-pass-trigger'
import { bouncerHandler } from '../handlers/adapter-bouncer'
import { SECOND_PASS_WORTH_PAYING_FOR } from '../verification-verdict'
import { MYEMAILVERIFIER_PROVIDER_KEY } from '../handlers/adapter-myemailverifier'
import { fakeProspectsClient, type FakeRow } from './helpers/fake-prospects-client'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

const ORG = 'org-1'

// The first-pass verdict that makes a row worth paying to re-check, taken from the shared
// constant rather than typed out, so a change to the vendor translation map reaches here.
const WORTH_PAYING_FOR = SECOND_PASS_WORTH_PAYING_FOR[0]

/**
 * A candidate the batch read must select: unsuppressed, has an address, first pass left it
 * unresolved, never second-passed, unlocked, and past the tier gate.
 */
function candidate(id: string): FakeRow {
  return {
    id,
    organisation_id: ORG,
    email: `${id}@example.invalid`,
    country: null,
    suppressed: false,
    independent_email_status: WORTH_PAYING_FOR,
    // The provider that produced the first-pass status, taken from the shared constant:
    // it selects the verdict map, so a literal here would drift from the handler.
    verification_provider: MYEMAILVERIFIER_PROVIDER_KEY,
    second_pass_status: null,
    second_pass_attempt_count: 0,
    second_pass_locked_at: null,
    // Past the tier gate: sourced_tier is present, so excludeTierRejected keeps the row.
    sourced_tier: 'tier_1',
    tiering_reason: null,
  }
}

const probeResult = {
  email: 'unused@example.invalid',
  raw_status: 'deliverable',
  verdict: 'deliverable' as const,
  reason: 'accepted_email',
  score: 90,
  accept_all: true,
  provider: 'mail-host',
  verified_at: '2026-09-07T00:00:00.000Z',
}

beforeEach(() => vi.restoreAllMocks())
afterEach(() => vi.restoreAllMocks())

describe('the row cap on the paid second-pass read', () => {
  // THE POSITIVE CONTROL. Without it, every assertion below could be satisfied by a query
  // that returned nothing at all, and the cap would look enforced when the read was simply
  // broken.
  it('probes every candidate when the batch size is larger than the backlog', async () => {
    const probe = vi.spyOn(bouncerHandler, 'execute').mockResolvedValue(probeResult)
    const rows = [candidate('p1'), candidate('p2'), candidate('p3')]
    const { client } = fakeProspectsClient(rows, { count: 0 })

    const run = await runSecondPassBatch(client as unknown as SupabaseClient, ORG, 10)

    expect(probe).toHaveBeenCalledTimes(3)
    expect(run.total_verified).toBe(3)
  })

  // THE GUARD. maxBatchSize is the smaller arm of min(maxBatchSize, dailyRemaining), and the
  // daily budget is untouched here, so the in-run budget guard never fires. Delete
  // .limit(cappedBatchSize) and all five rows come back and all five are billed.
  it('probes only up to the requested batch size, with the daily budget wide open', async () => {
    const probe = vi.spyOn(bouncerHandler, 'execute').mockResolvedValue(probeResult)
    const rows = [
      candidate('p1'), candidate('p2'), candidate('p3'), candidate('p4'), candidate('p5'),
    ]
    // count: 0 means nothing has been spent today, so dailyRemaining is the full limit and
    // maxBatchSize is unambiguously the binding constraint.
    const { client } = fakeProspectsClient(rows, { count: 0 })

    const run = await runSecondPassBatch(client as unknown as SupabaseClient, ORG, 2)

    expect(probe).toHaveBeenCalledTimes(2)
    expect(run.calls_spent).toBe(2)
  })

  // The same cap seen through the writes rather than the provider calls. A locked row is a
  // row this run has committed to paying for, so the lock count is the spend commitment.
  it('locks only up to the requested batch size', async () => {
    vi.spyOn(bouncerHandler, 'execute').mockResolvedValue(probeResult)
    const rows = [candidate('p1'), candidate('p2'), candidate('p3'), candidate('p4')]
    const { client, applied } = fakeProspectsClient(rows, { count: 0 })

    await runSecondPassBatch(client as unknown as SupabaseClient, ORG, 1)

    const locked = applied.filter(a => 'second_pass_locked_at' in a.payload && a.payload.second_pass_locked_at !== null)
    const lockedIds = new Set(locked.flatMap(a => a.ids))
    expect(lockedIds.size).toBe(1)
  })

  // The ledger is the money record: one row per paid call, written before the probe. The cap
  // has to bind before the ledger, not after it.
  it('opens no more ledger entries than the batch size allows', async () => {
    vi.spyOn(bouncerHandler, 'execute').mockResolvedValue(probeResult)
    const rows = [candidate('p1'), candidate('p2'), candidate('p3'), candidate('p4')]
    const { client, inserted } = fakeProspectsClient(rows, { count: 0 })

    await runSecondPassBatch(client as unknown as SupabaseClient, ORG, 2)

    const ledgerRows = inserted.filter(i => i.table === 'verification_calls')
    expect(ledgerRows).toHaveLength(2)
  })

  // The other arm of the min(), kept so the two cannot be confused. This one the in-run
  // budget guard also covers, so it is NOT the mutation-sensitive case; it is here to show
  // the cap tracks the smaller of the two rather than always tracking maxBatchSize.
  it('falls back to the remaining daily budget when that is the smaller of the two', async () => {
    const probe = vi.spyOn(bouncerHandler, 'execute').mockResolvedValue(probeResult)
    const rows = [candidate('p1'), candidate('p2'), candidate('p3'), candidate('p4')]
    const { client } = fakeProspectsClient(rows, { count: SECOND_PASS_DAILY_CALL_LIMIT - 1 })

    const run = await runSecondPassBatch(client as unknown as SupabaseClient, ORG, 4)

    expect(probe).toHaveBeenCalledTimes(1)
    expect(run.calls_spent).toBe(1)
  })
})
