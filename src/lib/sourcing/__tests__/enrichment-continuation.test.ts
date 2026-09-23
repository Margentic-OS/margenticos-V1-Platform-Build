// One press of Enrich and tier keeps going until the backlog is clear or the request runs out
// of time.
//
// ─── WHAT WAS WRONG ───────────────────────────────────────────────────────────
//
// A press ran enrichApprovedBatch ONCE, for at most 100 prospects, and left the rest untouched
// with no queued job. An operator with 500 approved prospects pressed five times, and the
// "Enriching N" card counted down by 100 each time with nothing saying that was the design.
//
// ─── WHAT IS FAKED, AND WHAT IS NOT ───────────────────────────────────────────
//
// The clock and one pass of the enrichment trigger are injected; the loop, the budget decision
// and the remaining-count read are real. The trigger itself is not re-tested here: it has its
// own suite, and what matters at this level is how many times it is called, with what cap, and
// what the request reports afterwards.
//
// ─── THE SPEND, WHICH IS THE REASON EVERY CAP IS ASSERTED ─────────────────────
//
// Enrichment costs one Apollo credit per prospect. A loop with no ceiling and no budget would
// be a button that spends without limit, so the per-pass cap, the per-press ceiling and the
// budget each get an assertion that fails if it is removed.

import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  enrichApprovedUntilDoneOrOutOfTime,
  ENRICHMENT_MAX_PER_REQUEST,
} from '../enrichment-continuation'
import { ENRICHMENT_PER_PRESS_LIMIT } from '../enrichment-trigger'
import type { EnrichmentRun } from '../handlers/adapter-apollo-enrichment'

const ORG = '11111111-2222-3333-4444-555555555555'

/** What one pass returns when it enriched `n` prospects. */
function pass(n: number, overrides: Partial<EnrichmentRun> = {}): EnrichmentRun {
  return {
    organisation_id: ORG,
    batch_size: n,
    total_requested_enrichments: n,
    unique_enriched_records: n,
    missing_records: 0,
    credits_consumed: n,
    enriched_at: new Date().toISOString(),
    status: 'success',
    ...overrides,
  } as EnrichmentRun
}

/**
 * A database fake whose only job is the remaining-count read.
 *
 * It HONOURS the filters, because the count is what the operator is told is still waiting and a
 * fake that ignored `.eq('sourcing_review_status', 'approved')` could not tell a correct query
 * from one that counted every prospect in the table.
 */
function makeSupabase(waitingRows: Record<string, unknown>[], failCount = false) {
  const seen: { filters: [string, unknown][]; isNulls: string[] }[] = []
  return {
    calls: seen,
    client: {
      from(table: string) {
        if (table !== 'prospects') {
          throw new Error(`fake supabase: unexpected table ${table}`)
        }
        const filters: [string, unknown][] = []
        const isNulls: string[] = []
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: (c: string, v: unknown) => { filters.push([c, v]); return chain },
          is: (c: string, v: unknown) => {
            if (v !== null) throw new Error(`fake supabase: is(${c}, ${String(v)}) not implemented`)
            isNulls.push(c)
            return chain
          },
          then: (resolve: (value: { count: number | null; error: unknown }) => unknown) => {
            seen.push({ filters: [...filters], isNulls: [...isNulls] })
            if (failCount) {
              return Promise.resolve({
                count: null, error: { message: 'simulated count failure' },
              }).then(resolve)
            }
            const matching = waitingRows.filter(row =>
              filters.every(([c, v]) => row[c] === v)
              && isNulls.every(c => row[c] === null || row[c] === undefined))
            return Promise.resolve({ count: matching.length, error: null }).then(resolve)
          },
        }
        return chain
      },
    } as unknown as SupabaseClient,
  }
}

/** A row that the remaining-count query should match. */
function waitingRow() {
  return {
    // organisation_id IS REQUIRED HERE. Leaving it out made the count return 0 for every case,
    // which looked like the code failing to read the backlog and was the fixture failing to
    // match its own query. The fake honours the filter, so an incomplete row is caught.
    organisation_id: ORG,
    sourcing_review_status: 'approved',
    enrichment_status: null,
    enrichment_credit_consumed_at: null,
  }
}

function makeClock() {
  let nowMs = 1_000_000
  return { now: () => nowMs, charge: (ms: number) => { nowMs += ms } }
}

describe('the per-press ceiling and the per-pass limit are different numbers', () => {
  it('caps a pass at the per-pass limit and a press at the per-press ceiling', () => {
    // The distinction the whole change rests on. If these were one number, either a press would
    // stop at 100 (the defect) or one call to the trigger would ask for 500 at once (which is
    // not what its lock, its selection or its Apollo batching are built for).
    expect(ENRICHMENT_PER_PRESS_LIMIT).toBe(100)
    expect(ENRICHMENT_MAX_PER_REQUEST).toBe(500)
    expect(ENRICHMENT_MAX_PER_REQUEST).toBeGreaterThan(ENRICHMENT_PER_PRESS_LIMIT)
  })
})

describe('one press clears the backlog', () => {
  it('makes five passes for 500 waiting, and never asks for more than 100 in one', async () => {
    const clock = makeClock()
    const db = makeSupabase([])
    const asked: number[] = []
    let left = 500

    const result = await enrichApprovedUntilDoneOrOutOfTime(db.client, ORG, {
      clock: clock.now,
      runPass: async (max) => {
        asked.push(max)
        clock.charge(25_000) // the measured cost of 100: ~25s on production, 2026-09-21
        const n = Math.min(max, left)
        left -= n
        return pass(n)
      },
    })

    // FIVE PASSES IN ONE PRESS. This is the defect fixed: it used to be one.
    expect(result.presses).toBe(5)
    // AND EVERY PASS ASKED FOR AT MOST 100. A pass asking for 500 would bypass the trigger's
    // own lock and selection sizing.
    expect(asked).toEqual([100, 100, 100, 100, 100])
    expect(asked.every(n => n <= ENRICHMENT_PER_PRESS_LIMIT)).toBe(true)

    expect(result.enriched).toBe(500)
    expect(result.credits_consumed).toBe(500)
    expect(result.remaining).toBe(0)
    expect(result.stop_reason).toBe('target_met')
    expect(result.stop_message).toContain('Nothing is left waiting')
    expect(result.error).toBeNull()
  })

  it('stops as soon as nothing more can be selected, without spending another pass', async () => {
    // 140 waiting: two passes, the second short. A third pass would be a paid call for nothing.
    const clock = makeClock()
    const db = makeSupabase([])
    let left = 140
    let calls = 0

    const result = await enrichApprovedUntilDoneOrOutOfTime(db.client, ORG, {
      clock: clock.now,
      runPass: async (max) => {
        calls++
        clock.charge(10_000)
        const n = Math.min(max, left)
        left -= n
        return pass(n)
      },
    })

    expect(calls).toBe(2)
    expect(result.enriched).toBe(140)
    expect(result.stop_reason).toBe('provider_exhausted')
    expect(result.remaining).toBe(0)
  })
})

describe('the press still stops, and says so', () => {
  it('stops at the budget on a slow day and reports what is still waiting', async () => {
    // The measured slow case: 2026-09-15, 30 prospects in 59,835 ms, ~1,994 ms each. A pass of
    // 100 at that rate is ~200s of a 240s budget, so a second pass cannot fit.
    const clock = makeClock()
    // 400 rows still match the waiting predicate after the one pass that ran.
    const db = makeSupabase(Array.from({ length: 400 }, waitingRow))
    let calls = 0

    const result = await enrichApprovedUntilDoneOrOutOfTime(db.client, ORG, {
      clock: clock.now,
      runPass: async (max) => {
        calls++
        clock.charge(200_000)
        return pass(max)
      },
    })

    expect(calls).toBe(1)
    expect(result.stop_reason).toBe('budget_exhausted')
    // THE COUNT IS READ BACK, not subtracted. A press that enriched 100 of 500 does not know
    // 400 remain: another session can approve prospects while this request runs.
    expect(result.remaining).toBe(400)
    expect(result.stop_message).toContain('400 still waiting')
    expect(result.stop_message).toContain('Press Enrich and tier again')
    expect(result.stop_message).toContain('nothing is charged twice')
  })

  it('stops at the per-press ceiling and names another press, without spending past it', async () => {
    // 700 waiting against a ceiling of 500. Auto-continue does not mean unlimited spend.
    const clock = makeClock()
    const db = makeSupabase(Array.from({ length: 200 }, waitingRow))
    let spent = 0

    const result = await enrichApprovedUntilDoneOrOutOfTime(db.client, ORG, {
      clock: clock.now,
      runPass: async (max) => {
        clock.charge(1_000)
        spent += max
        return pass(max)
      },
    })

    // EXACTLY THE CEILING. Deleting the ceiling makes this 700 and makes the button a
    // spend-without-limit control.
    expect(spent).toBe(ENRICHMENT_MAX_PER_REQUEST)
    expect(result.credits_consumed).toBe(ENRICHMENT_MAX_PER_REQUEST)
    expect(result.presses).toBe(5)
    expect(result.remaining).toBe(200)
    expect(result.stop_message).toContain('200 still waiting')
  })

  it('stops on the FIRST failing pass rather than turning one failure into five', async () => {
    const clock = makeClock()
    const db = makeSupabase(Array.from({ length: 400 }, waitingRow))
    let calls = 0

    const result = await enrichApprovedUntilDoneOrOutOfTime(db.client, ORG, {
      clock: clock.now,
      runPass: async (max) => {
        calls++
        clock.charge(5_000)
        if (calls === 2) {
          return pass(0, { status: 'failed', error_message: 'Apollo returned 429' })
        }
        return pass(max)
      },
    })

    // TWO CALLS, NOT FIVE. A pass that failed usually failed for a reason the next one meets
    // too, and each attempt can spend.
    expect(calls).toBe(2)
    expect(result.error).toBe('Apollo returned 429')
    // What the first pass DID enrich is still reported: it happened and it was paid for.
    expect(result.enriched).toBe(100)
    expect(result.credits_consumed).toBe(100)
  })
})

describe('the remaining count', () => {
  it('asks the selection question, not "how many prospects are there"', async () => {
    const clock = makeClock()
    const db = makeSupabase([])
    await enrichApprovedUntilDoneOrOutOfTime(db.client, ORG, {
      clock: clock.now,
      runPass: async () => { clock.charge(1_000); return pass(0) },
    })

    expect(db.calls).toHaveLength(1)
    const q = db.calls[0]
    // Every predicate the enrichment selection applies. A count missing any of these would tell
    // the operator the wrong number: without the credit-consumed check it would re-count
    // prospects Apollo has already been paid for.
    expect(q.filters).toEqual(
      expect.arrayContaining([['organisation_id', ORG], ['sourcing_review_status', 'approved']]),
    )
    expect(q.isNulls).toEqual(
      expect.arrayContaining(['enrichment_status', 'enrichment_credit_consumed_at']),
    )
  })

  it('reports -1 rather than 0 when the count could not be read', async () => {
    // ZERO WOULD BE A LIE THAT READS AS GOOD NEWS: "nothing is left waiting" when the truth is
    // that we could not find out. Same shape as the sourcing cursor refusing to assume offset 0.
    const clock = makeClock()
    const db = makeSupabase([], true)

    const result = await enrichApprovedUntilDoneOrOutOfTime(db.client, ORG, {
      clock: clock.now,
      runPass: async () => { clock.charge(1_000); return pass(0) },
    })

    expect(result.remaining).toBe(-1)
    expect(result.stop_message).not.toContain('Nothing is left waiting')
    expect(result.stop_message).toContain('an unknown number')
  })
})
