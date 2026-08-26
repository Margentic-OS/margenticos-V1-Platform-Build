// Safety tests for the PAID second pass.
//
// Modelled on verification-trigger-safety.test.ts, which exists because three of the four
// bugs it covers are about which WRITES happen on which path, and a unit test of the pure
// parts cannot see a write that never happened. The same shape is used here.
//
// The difference is what a bug COSTS. On the free first pass a stranded lock wastes a call
// out of 100/day. Here every probe is billed, so the failure modes below are about money:
// a lock that strands, an attempt that does not count and is therefore re-billed forever,
// a budget read that fails open, and a paid call that leaves no trace.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { runSecondPassBatch, SECOND_PASS_DAILY_CALL_LIMIT } from '../second-pass-trigger'
import { bouncerHandler } from '../handlers/adapter-bouncer'

const ORG = 'org-1'

interface FakeRow {
  id: string
  email: string | null
  country?: string | null
  independent_email_status?: string | null
  verification_provider?: string | null
  second_pass_attempt_count?: number
}

interface Applied { table: string; ids: string[]; payload: Record<string, unknown> }
interface Inserted { table: string; payload: Record<string, unknown> }

function fakeSupabase(
  rows: FakeRow[],
  opts: { dailyCount?: number; countError?: string; ledgerInsertError?: string } = {},
) {
  const applied: Applied[] = []
  const inserted: Inserted[] = []
  let ledgerSeq = 0

  const client = {
    from(table: string) {
      let ids: string[] = []
      let mode: 'rows' | 'count' | 'single' = 'rows'

      const chain: Record<string, unknown> = {
        select(_cols: string, o?: { count?: string; head?: boolean }) {
          if (o?.head) mode = 'count'
          return chain
        },
        eq(col: string, val: string) { if (col === 'id') ids = [val]; return chain },
        in(col: string, vals: string[]) { if (col === 'id') ids = vals; return chain },
        is() { return chain },
        or() { return chain },
        not() { return chain },
        lt() { return chain },
        gte() { return chain },
        order() { return chain },
        limit() { return chain },
        maybeSingle() {
          mode = 'single'
          const row = rows.find(r => r.id === ids[0])
          return Promise.resolve({
            data: row ? { second_pass_attempt_count: row.second_pass_attempt_count ?? 0 } : null,
            error: null,
          })
        },
        insert(payload: Record<string, unknown>) {
          inserted.push({ table, payload })
          const ins: Record<string, unknown> = {
            select() { return ins },
            maybeSingle() {
              if (opts.ledgerInsertError) {
                return Promise.resolve({ data: null, error: { message: opts.ledgerInsertError } })
              }
              return Promise.resolve({ data: { id: `call-${++ledgerSeq}` }, error: null })
            },
            then(resolve: (v: unknown) => void) { resolve({ data: null, error: null }) },
          }
          return ins
        },
        update(payload: Record<string, unknown>) {
          const upd: Record<string, unknown> = {
            eq(col: string, val: string) { if (col === 'id') ids = [val]; return upd },
            in(col: string, vals: string[]) { if (col === 'id') ids = vals; return upd },
            then(resolve: (v: unknown) => void) {
              applied.push({ table, ids: [...ids], payload })
              resolve({ data: null, error: null })
            },
          }
          return upd
        },
        then(resolve: (v: unknown) => void) {
          if (mode === 'count') {
            resolve(
              opts.countError
                ? { count: null, error: { message: opts.countError } }
                : { count: opts.dailyCount ?? 0, error: null },
            )
            return
          }
          resolve({
            data: rows.map(r => ({
              id: r.id,
              email: r.email,
              country: r.country ?? null,
              independent_email_status: r.independent_email_status ?? 'Catch All',
              verification_provider: r.verification_provider ?? 'myemailverifier',
            })),
            error: null,
          })
        },
      }
      return chain
    },
  }

  return { client: client as unknown as SupabaseClient, applied, inserted }
}

const payloadsFor = (applied: Applied[], id: string) =>
  applied.filter(a => a.ids.includes(id)).map(a => a.payload)

const deliverable = {
  email: 'a@b.com', raw_status: 'deliverable', verdict: 'deliverable' as const,
  reason: 'accepted_email', score: 90, accept_all: true, provider: 'google',
  verified_at: '2026-08-25T00:00:00Z',
}
const risky = { ...deliverable, raw_status: 'risky', verdict: 'risky' as const, reason: 'low_deliverability', score: 75 }

beforeEach(() => vi.restoreAllMocks())
afterEach(() => vi.restoreAllMocks())

describe('the money: every paid call is counted before it is made', () => {
  it('writes a ledger row BEFORE the probe, so a call that fails is still counted', async () => {
    vi.spyOn(bouncerHandler, 'execute').mockRejectedValue(new Error('vendor exploded'))
    const { client, inserted } = fakeSupabase([{ id: 'p1', email: 'a@b.com' }])

    await runSecondPassBatch(client, ORG, 5)

    // The whole reason the ledger exists. Counting verdicts on prospects would undercount
    // spend by exactly the failures, which is the stated residual of the free first pass and
    // is not acceptable when the calls are billed.
    const ledger = inserted.filter(i => i.table === 'verification_calls')
    expect(ledger).toHaveLength(1)
    expect(ledger[0].payload.outcome).toBe('attempted')
    expect(ledger[0].payload.provider).toBe('bouncer')
    expect(ledger[0].payload.prospect_id).toBe('p1')
  })

  it('counts the call in the run total even when the probe throws', async () => {
    vi.spyOn(bouncerHandler, 'execute').mockRejectedValue(new Error('vendor exploded'))
    const { client } = fakeSupabase([{ id: 'p1', email: 'a@b.com' }])

    const run = await runSecondPassBatch(client, ORG, 5)

    expect(run.calls_spent).toBe(1)
    expect(run.failed_count).toBe(1)
    expect(run.total_verified).toBe(0)
  })

  it('FAILS CLOSED when the budget count cannot be read', async () => {
    const probe = vi.spyOn(bouncerHandler, 'execute').mockResolvedValue(deliverable)
    const { client } = fakeSupabase([{ id: 'p1', email: 'a@b.com' }], { countError: 'db down' })

    const run = await runSecondPassBatch(client, ORG, 5)

    // Falling through with `?? 0` would tell the run it had the whole day's budget free,
    // which is the most expensive possible guess. This is the first pass's fix, applied
    // where the guess actually costs cash.
    expect(run.status).toBe('failed')
    expect(probe).not.toHaveBeenCalled()
    expect(run.calls_spent).toBe(0)
  })

  it('spends nothing once the daily cap is reached', async () => {
    const probe = vi.spyOn(bouncerHandler, 'execute').mockResolvedValue(deliverable)
    const { client } = fakeSupabase(
      [{ id: 'p1', email: 'a@b.com' }],
      { dailyCount: SECOND_PASS_DAILY_CALL_LIMIT },
    )

    const run = await runSecondPassBatch(client, ORG, 5)

    expect(run.status).toBe('budget_exhausted')
    expect(probe).not.toHaveBeenCalled()
  })

  it('caps the batch to the remaining budget rather than the requested size', async () => {
    const probe = vi.spyOn(bouncerHandler, 'execute').mockResolvedValue(deliverable)
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, email: `a${i}@b.com` }))
    const { client } = fakeSupabase(rows, { dailyCount: SECOND_PASS_DAILY_CALL_LIMIT - 2 })

    await runSecondPassBatch(client, ORG, 5)

    // The fake returns every row regardless of .limit(), so the in-run budget guard is what
    // has to stop the spend. Two calls remain in the budget, so two probes.
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('still probes when the ledger insert fails, and says so, rather than stalling', async () => {
    const probe = vi.spyOn(bouncerHandler, 'execute').mockResolvedValue(deliverable)
    const { client } = fakeSupabase([{ id: 'p1', email: 'a@b.com' }], { ledgerInsertError: 'insert failed' })

    const run = await runSecondPassBatch(client, ORG, 5)

    // A deliberate trade-off, commented at openLedgerEntry: a bookkeeping failure should not
    // stall a backlog when the budget carries 18x headroom.
    expect(probe).toHaveBeenCalledTimes(1)
    expect(run.total_verified).toBe(1)
  })
})

describe('the lock: nothing may strand, because a stranded row is a paid call never made', () => {
  it('releases the lock when the probe throws', async () => {
    vi.spyOn(bouncerHandler, 'execute').mockRejectedValue(new Error('SMTP refused'))
    const { client, applied } = fakeSupabase([{ id: 'p1', email: 'a@b.com' }])

    await runSecondPassBatch(client, ORG, 5)

    expect(payloadsFor(applied, 'p1').some(p => p.second_pass_locked_at === null)).toBe(true)
  })

  it('COUNTS THE ATTEMPT when the probe throws, so the retry cap binds and re-billing stops', async () => {
    vi.spyOn(bouncerHandler, 'execute').mockRejectedValue(new Error('SMTP refused'))
    const { client, applied } = fakeSupabase([{ id: 'p1', email: 'a@b.com', second_pass_attempt_count: 1 }])

    await runSecondPassBatch(client, ORG, 5)

    // Without this the stale reclaim would re-probe a permanently bad address every 30
    // minutes and BILL FOR EACH ONE. On the free pass that wastes quota; here it is an
    // open-ended charge against a live card.
    const counted = payloadsFor(applied, 'p1').some(p => p.second_pass_attempt_count === 2)
    expect(counted).toBe(true)
  })

  it('releases the lock on a prospect with no email, which never resolves on its own', async () => {
    const { client, applied } = fakeSupabase([{ id: 'p1', email: null }])

    await runSecondPassBatch(client, ORG, 5)

    expect(payloadsFor(applied, 'p1').some(p => p.second_pass_locked_at === null)).toBe(true)
  })
})

describe('the verdict write goes through the shared resolver, not an inline expression', () => {
  it('marks a recovered catch-all send-eligible', async () => {
    vi.spyOn(bouncerHandler, 'execute').mockResolvedValue(deliverable)
    const { client, applied } = fakeSupabase([
      { id: 'p1', email: 'emily@esstrategic.co', country: 'US', independent_email_status: 'Catch All' },
    ])

    const run = await runSecondPassBatch(client, ORG, 5)

    const write = payloadsFor(applied, 'p1').find(p => 'second_pass_status' in p)
    expect(write?.email_send_eligible).toBe(true)
    expect(write?.second_pass_status).toBe('deliverable')
    expect(write?.second_pass_score).toBe(90)
    expect(write?.second_pass_accept_all).toBe(true)
    expect(write?.second_pass_provider).toBe('bouncer')
    expect(run.recovered_count).toBe(1)
  })

  it('leaves a still-risky catch-all ineligible', async () => {
    vi.spyOn(bouncerHandler, 'execute').mockResolvedValue(risky)
    const { client, applied } = fakeSupabase([
      { id: 'p1', email: 'sohail@thesouthstarconsulting.com', country: 'US', independent_email_status: 'Catch All' },
    ])

    const run = await runSecondPassBatch(client, ORG, 5)

    const write = payloadsFor(applied, 'p1').find(p => 'second_pass_status' in p)
    expect(write?.email_send_eligible).toBe(false)
    // The score is still recorded even though it did not decide anything.
    expect(write?.second_pass_score).toBe(75)
    expect(run.recovered_count).toBe(0)
    expect(run.still_unusable_count).toBe(1)
  })

  it('THE PREREQUISITE: a German catch-all resolved to deliverable stays BLOCKED', async () => {
    vi.spyOn(bouncerHandler, 'execute').mockResolvedValue(deliverable)
    const { client, applied } = fakeSupabase([
      { id: 'p1', email: 'jochen@knot-consulting.com', country: 'DE', independent_email_status: 'Catch All' },
    ])

    await runSecondPassBatch(client, ORG, 5)

    // This is the exact scenario the country backfill was a hard prerequisite for. A
    // deliverable verdict must not override a jurisdiction exclusion.
    const write = payloadsFor(applied, 'p1').find(p => 'second_pass_status' in p)
    expect(write?.email_send_eligible).toBe(false)
    expect(write?.email_send_ineligible_reason).toBe('country_excluded_de')
    // And the verdict is still recorded, because the money was spent either way.
    expect(write?.second_pass_status).toBe('deliverable')
  })

  it('does NOT report a jurisdiction-blocked address as recovered', async () => {
    vi.spyOn(bouncerHandler, 'execute').mockResolvedValue(deliverable)
    const { client } = fakeSupabase([
      { id: 'p1', email: 'jochen@knot-consulting.com', country: 'DE', independent_email_status: 'Catch All' },
    ])

    const run = await runSecondPassBatch(client, ORG, 5)

    // recovered_count is read by an operator off the heartbeat as "prospects I can now
    // mail". A deliverable verdict on an excluded address is a verdict we paid for and
    // cannot use, so counting it there would overstate the return on the spend.
    expect(run.recovered_count).toBe(0)
    expect(run.still_unusable_count).toBe(1)
    expect(run.total_verified).toBe(1)
  })
})
