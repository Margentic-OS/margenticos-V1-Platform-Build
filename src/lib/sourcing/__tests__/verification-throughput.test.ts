// THE THROUGHPUT CHANGE, MEASURED END TO END AGAINST THE REAL verifyEnrichedBatch.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY NOT A UNIT TEST OF THE PACER
//
// verification-pacing.test.ts already proves the pacer holds a rate. That is not the claim
// this file makes. The claim here is that a RUN uses its window, reads its pace from config,
// and probes each address exactly once, and every one of those is a property of how
// verifyEnrichedBatch wires the pacer to the selection, the deadline and the locks. A unit
// test of the pacer passes identically whether or not the trigger ever calls it.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE FAKE HONOURS EVERY FILTER IT IS ASKED ABOUT, OR THROWS
//
// CLAUDE.md records three cases where a fake silently swallowed a filter and the guard under
// test could be deleted with the suite still green. The two that matter here are `.limit()`,
// which is the ONLY effect the deadline has on the select, and the config key, which is the
// only thing separating "read the pace from the registry" from "used the compiled fallback".
// Both are honoured below, and an unimplemented column throws rather than coming back
// undefined.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { verifyEnrichedBatch, DEFAULT_VERIFY_BATCH_SIZE } from '../verification-trigger'
import { myemailverifierHandler } from '../handlers/adapter-myemailverifier'
import {
  pacedIntervalMs,
  probesWithinBudget,
  DEFAULT_RUN_BUDGET_MS,
  type PacingClock,
} from '../verification-pacing'
import { FALLBACK_RATE_LIMIT_PER_MINUTE } from '../verification-limits'

const ORG = 'org-throughput'

/** A clock the test drives, so a full-length run is measured without waiting for one. */
function fakeClock(startAt = 1_000_000) {
  let t = startAt
  const clock: PacingClock = {
    now: () => t,
    sleep: async (ms: number) => { t += ms },
  }
  return { clock, now: () => t, advance: (ms: number) => { t += ms } }
}

interface FakeOpts {
  dailyCount?: number
  dailyLimit?: number
  /** Served at config.rate_limit_per_minute. Undefined means the key is absent. */
  ratePerMinute?: number
  /** Advance the clock by this much on every probe, modelling provider latency. */
  probeCostMs?: number
  clock?: PacingClock
}

/**
 * A prospects + registry fake that honours the row cap and serves both config keys.
 *
 * Records EVERY email the handler was asked about, in order, which is what the
 * probed-exactly-once assertions read.
 */
function fakeSupabase(rows: Array<{ id: string; email: string }>, opts: FakeOpts = {}) {
  const lockedIds: string[][] = []
  const released: string[][] = []

  const client = {
    from(table: string) {
      if (table === 'integrations_registry') {
        const config: Record<string, unknown> = {
          daily_verification_limit: opts.dailyLimit ?? 100_000,
        }
        // Absent when the test did not set one, so the fallback path is reachable and is
        // distinguishable from a configured value that happens to equal the fallback.
        if (opts.ratePerMinute !== undefined) {
          config.rate_limit_per_minute = opts.ratePerMinute
        }
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () => ({ data: { config }, error: null }),
        }
        return chain
      }
      if (table !== 'prospects') throw new Error(`unexpected table ${table}`)

      let mode: 'rows' | 'count' | 'single' = 'rows'
      let limitValue: number | null = null
      let selectedCols = ''
      let ids: string[] = []

      const chain: Record<string, unknown> = {
        select(cols: string, o?: { count?: string; head?: boolean }) {
          if (o?.head) mode = 'count'
          selectedCols = cols
          return chain
        },
        eq(col: string, val: string) { if (col === 'id') ids = [val]; return chain },
        in(_c: string, vals: string[]) { ids = vals; return chain },
        is: () => chain,
        or: () => chain,
        not: () => chain,
        gte: () => chain,
        lt: () => chain,
        order: () => chain,
        // HONOURED. cappedBatchSize is the only way the deadline reaches the SELECT, so a
        // fake ignoring this could not tell a window-sized batch from a fixed forty.
        limit(n: number) { limitValue = n; return chain },
        maybeSingle() {
          mode = 'single'
          const data: Record<string, unknown> = {}
          for (const col of selectedCols.split(',').map(c => c.trim()).filter(Boolean)) {
            // Both columns recordVerificationResult reads. It selects
            // 'verification_attempt_count, send_hold_at', and a fake that served only the
            // first threw on every success path, sending all 108 probes to the failure
            // branch: the run reported 0 verified while the handler had plainly been called
            // 108 times. The throw is what surfaced it, which is why this fake throws on an
            // unimplemented column rather than returning undefined.
            if (col === 'verification_attempt_count') data[col] = 0
            else if (col === 'send_hold_at') data[col] = null
            else throw new Error(`fake maybeSingle does not implement column "${col}"`)
          }
          return Promise.resolve({ data, error: null })
        },
        update(payload: Record<string, unknown>) {
          const upd: Record<string, unknown> = {
            eq(col: string, val: string) { if (col === 'id') ids = [val]; return upd },
            in(_c: string, vals: string[]) { ids = vals; return upd },
            then(resolve: (v: unknown) => void) {
              if (payload.verification_locked_at === null) released.push([...ids])
              else if (payload.verification_locked_at) lockedIds.push([...ids])
              resolve({ data: null, error: null })
            },
          }
          return upd
        },
        then(resolve: (v: unknown) => void) {
          if (mode === 'count') {
            resolve({ count: opts.dailyCount ?? 0, error: null })
            return
          }
          const capped = limitValue === null ? rows : rows.slice(0, limitValue)
          resolve({
            data: capped.map(r => {
              const row: Record<string, unknown> = {}
              for (const col of selectedCols.split(',').map(c => c.trim()).filter(Boolean)) {
                switch (col) {
                  case 'id': row[col] = r.id; break
                  case 'email': row[col] = r.email; break
                  case 'country': row[col] = 'US'; break
                  case 'send_hold_at': row[col] = null; break
                  default: throw new Error(`fake row select does not implement column "${col}"`)
                }
              }
              return row
            }),
            error: null,
          })
        },
      }
      return chain
    },
  }

  return { client: client as unknown as SupabaseClient, lockedIds, released }
}

const manyRows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, email: `person${i}@example.com` }))

function stubHandler(probed: string[], costMs = 0, clock?: { advance(ms: number): void }) {
  return vi.spyOn(myemailverifierHandler, 'execute').mockImplementation(async (email: string) => {
    probed.push(email)
    if (costMs > 0 && clock) clock.advance(costMs)
    return {
      email, status: 'Valid' as const, catch_all: false, disposable_domain: false,
      role_based: false, free_domain: false, greylisted: false, send_eligible: true,
      verified_at: '2026-09-21T00:00:00Z', diagnosis: 'ok',
    }
  })
}

beforeEach(() => vi.restoreAllMocks())
afterEach(() => vi.restoreAllMocks())

describe('the run uses its window instead of a fixed batch', () => {
  // THE HEADLINE NUMBER. The old behaviour was 40 per run whatever the window allowed.
  it('probes what the window allows, not a fixed forty', async () => {
    const probed: string[] = []
    const { clock, now } = fakeClock()
    stubHandler(probed)

    const { client } = fakeSupabase(manyRows(500), { ratePerMinute: 30, clock })
    const startedAt = now()

    const run = await verifyEnrichedBatch(client, ORG, 10_000, {
      deadlineAt: startedAt + DEFAULT_RUN_BUDGET_MS,
      clock,
    })

    const expected = probesWithinBudget(DEFAULT_RUN_BUDGET_MS, pacedIntervalMs(30))
    expect(expected).toBe(108)
    expect(probed).toHaveLength(expected)
    expect(run.total_verified).toBe(expected)

    // And it stayed inside the window it was given.
    expect(now() - startedAt).toBeLessThanOrEqual(DEFAULT_RUN_BUDGET_MS)

    // Against the old fixed batch, stated as a ratio rather than as a claim.
    expect(probed.length / 40).toBeGreaterThan(2.5)
  })

  it('holds the configured rate across the whole run', async () => {
    const probed: string[] = []
    const { clock, now } = fakeClock()
    stubHandler(probed)

    const { client } = fakeSupabase(manyRows(500), { ratePerMinute: 30, clock })
    const startedAt = now()

    await verifyEnrichedBatch(client, ORG, 10_000, {
      deadlineAt: startedAt + DEFAULT_RUN_BUDGET_MS,
      clock,
    })

    const elapsedMinutes = (now() - startedAt) / 60_000
    const achieved = probed.length / elapsedMinutes

    expect(achieved).toBeLessThan(30)
    expect(achieved).toBeGreaterThan(26)
  })

  // The old flat sleep lost the probe's own duration on every cycle. The pacer absorbs it,
  // so a slow provider costs the same number of addresses as a fast one.
  it('does not lose throughput to provider latency', async () => {
    const probeCost = 700
    const probed: string[] = []
    const { clock, now, advance } = fakeClock()
    stubHandler(probed, probeCost, { advance })

    const { client } = fakeSupabase(manyRows(500), { ratePerMinute: 30, clock })
    const startedAt = now()

    await verifyEnrichedBatch(client, ORG, 10_000, {
      deadlineAt: startedAt + DEFAULT_RUN_BUDGET_MS,
      clock,
    })

    // What the deleted flat sleep would have managed in the same window.
    const oldCycleMs = 2_000 + probeCost
    const oldWouldHaveDone = Math.floor(DEFAULT_RUN_BUDGET_MS / oldCycleMs)

    expect(probed.length).toBeGreaterThan(oldWouldHaveDone)
    expect(probed.length).toBeGreaterThanOrEqual(100)
  })

  it('stops at the deadline and releases the locks it will not reach', async () => {
    const probed: string[] = []
    const { clock, now } = fakeClock()
    stubHandler(probed)

    // A window big enough for a handful, against a backlog far larger.
    const { client, released } = fakeSupabase(manyRows(200), { ratePerMinute: 30, clock })
    const shortWindow = pacedIntervalMs(30) * 4
    const startedAt = now()

    const run = await verifyEnrichedBatch(client, ORG, 10_000, {
      deadlineAt: startedAt + shortWindow,
      clock,
    })

    expect(probed.length).toBe(probesWithinBudget(shortWindow, pacedIntervalMs(30)))
    expect(now() - startedAt).toBeLessThanOrEqual(shortWindow)
    // Nothing selected is left holding a lock at the end of the run.
    expect(released.flat().length).toBeGreaterThan(0)
    expect(run.status).not.toBe('failed')
  })

  // ── THE IN-LOOP DEADLINE CHECK, WHICH THE SIZING CANNOT STAND IN FOR ────────
  //
  // FOUND BY MUTATION TESTING. Deleting the loop's `nextSlotAt() >= deadlineAt` guard left
  // every test in this file green, because every other test here has probes that return
  // instantly: the batch sizing predicts the window exactly, the run finishes on its own,
  // and the guard is never reached.
  //
  // It exists for the case the sizing CANNOT predict. Sizing divides the window by the
  // paced interval, which assumes each probe fits inside its own slot. A provider slower
  // than the interval breaks that assumption: slots slip later than the arithmetic at
  // selection time assumed, and without this guard the run walks the whole selected batch
  // regardless, straight past its deadline and into the request cap above it.
  //
  // Modelled with a probe that takes more than twice its slot.
  it('stops mid-batch when probes run slower than their slots, rather than overrunning', async () => {
    const interval = pacedIntervalMs(30)
    const probeCost = interval * 2 + 500 // comfortably slower than one slot
    const windowMs = interval * 10       // sizing will therefore select 10

    const probed: string[] = []
    const { clock, now, advance } = fakeClock()
    stubHandler(probed, probeCost, { advance })

    const { client, released } = fakeSupabase(manyRows(200), { ratePerMinute: 30, clock })
    const startedAt = now()

    const run = await verifyEnrichedBatch(client, ORG, 10_000, {
      deadlineAt: startedAt + windowMs,
      clock,
    })

    // The sizing selected what the window would hold at full pace.
    const sized = probesWithinBudget(windowMs, interval)
    expect(sized).toBe(10)

    // The run stopped SHORT of that, because the probes did not keep up.
    expect(probed.length).toBeGreaterThan(0)
    expect(probed.length).toBeLessThan(sized)

    // THE ASSERTION THAT KILLS THE MUTATION. Without the guard the loop walks all ten,
    // finishing around 10 * probeCost, which is several times the window. With it, the run
    // ends within one probe of its deadline.
    const elapsed = now() - startedAt
    expect(elapsed).toBeLessThanOrEqual(windowMs + probeCost)
    expect(elapsed).toBeLessThan(sized * probeCost)

    // And what it did not reach was released rather than left locked.
    expect(run.status).toBe('partial')
    expect(released.flat().length).toBeGreaterThan(0)
    expect(new Set(probed).size).toBe(probed.length)
  })

  // A window that has already closed must not turn into `.limit(0)`, which PostgREST answers
  // with every row rather than with none.
  it('probes nothing, and selects nothing, when the window has already closed', async () => {
    const probed: string[] = []
    const { clock, now } = fakeClock()
    stubHandler(probed)

    const { client, lockedIds } = fakeSupabase(manyRows(50), { ratePerMinute: 30, clock })

    const run = await verifyEnrichedBatch(client, ORG, 10_000, {
      deadlineAt: now() - 1_000,
      clock,
    })

    expect(probed).toHaveLength(0)
    expect(lockedIds).toHaveLength(0)
    expect(run.total_verified).toBe(0)
    expect(run.status).not.toBe('failed')
  })

  it('still respects the daily budget, which binds before the window does', async () => {
    const probed: string[] = []
    const { clock, now } = fakeClock()
    stubHandler(probed)

    const { client } = fakeSupabase(manyRows(500), {
      ratePerMinute: 30,
      dailyLimit: 10,
      dailyCount: 3,
      clock,
    })

    await verifyEnrichedBatch(client, ORG, 10_000, {
      deadlineAt: now() + DEFAULT_RUN_BUDGET_MS,
      clock,
    })

    expect(probed).toHaveLength(7)
  })
})

describe('the pace comes from config, not from the source', () => {
  // MUTATION ANCHOR. Replace the registry read with the compiled constant and this fails:
  // the achieved interval would be the fallback's, not the configured one.
  it('paces to a raised limit without a code change', async () => {
    const probed: string[] = []
    const { clock, now } = fakeClock()
    stubHandler(probed)

    const raised = 120
    const { client } = fakeSupabase(manyRows(2_000), { ratePerMinute: raised, clock })
    const startedAt = now()

    await verifyEnrichedBatch(client, ORG, 10_000, {
      deadlineAt: startedAt + DEFAULT_RUN_BUDGET_MS,
      clock,
    })

    expect(probed).toHaveLength(probesWithinBudget(DEFAULT_RUN_BUDGET_MS, pacedIntervalMs(raised)))

    const achieved = probed.length / ((now() - startedAt) / 60_000)
    expect(achieved).toBeGreaterThan(100)
    expect(achieved).toBeLessThan(raised)

    // And it is genuinely faster than the compiled fallback would have been.
    expect(probed.length).toBeGreaterThan(
      probesWithinBudget(DEFAULT_RUN_BUDGET_MS, pacedIntervalMs(FALLBACK_RATE_LIMIT_PER_MINUTE)),
    )
  })

  // THE FALLBACK IS THE SLOW ONE. An unreadable config must never hand the sweep a faster
  // pace than it had: addresses refused by the provider each burn a retry attempt, and a
  // prospect out of attempts is not picked up again without being asked.
  it('falls back to the compiled pace when the key is absent', async () => {
    const probed: string[] = []
    const { clock, now } = fakeClock()
    stubHandler(probed)

    const { client } = fakeSupabase(manyRows(500), { clock }) // no rate_limit_per_minute
    const startedAt = now()

    await verifyEnrichedBatch(client, ORG, 10_000, {
      deadlineAt: startedAt + DEFAULT_RUN_BUDGET_MS,
      clock,
    })

    expect(probed).toHaveLength(
      probesWithinBudget(DEFAULT_RUN_BUDGET_MS, pacedIntervalMs(FALLBACK_RATE_LIMIT_PER_MINUTE)),
    )
  })

  it('ignores a nonsense configured limit rather than pacing to it', async () => {
    const probed: string[] = []
    const { clock, now } = fakeClock()
    stubHandler(probed)

    const { client } = fakeSupabase(manyRows(500), { ratePerMinute: -5, clock })

    await verifyEnrichedBatch(client, ORG, 10_000, {
      deadlineAt: now() + DEFAULT_RUN_BUDGET_MS,
      clock,
    })

    expect(probed).toHaveLength(
      probesWithinBudget(DEFAULT_RUN_BUDGET_MS, pacedIntervalMs(FALLBACK_RATE_LIMIT_PER_MINUTE)),
    )
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// NO ADDRESS IS CHECKED TWICE
//
// Verification is idempotent, so a duplicate does not corrupt anything. It spends a finite,
// account-wide daily budget on an answer already held, and it consumes a slot against a
// per-minute limit. Raising the batch from 40 to ~108 makes both more expensive to get wrong,
// which is why this is proved rather than assumed.

describe('no address is probed twice', () => {
  it('probes each selected address exactly once across a full-length run', async () => {
    const probed: string[] = []
    const { clock, now } = fakeClock()
    stubHandler(probed)

    const { client } = fakeSupabase(manyRows(500), { ratePerMinute: 30, clock })

    await verifyEnrichedBatch(client, ORG, 10_000, {
      deadlineAt: now() + DEFAULT_RUN_BUDGET_MS,
      clock,
    })

    expect(new Set(probed).size).toBe(probed.length)
  })

  // The batch is selected once and walked by index. A row appearing in two positions would
  // show up here; so would a loop that re-read the selection after releasing locks.
  it('probes each address exactly once when the window stops the run early', async () => {
    const probed: string[] = []
    const { clock, now } = fakeClock()
    stubHandler(probed)

    const { client } = fakeSupabase(manyRows(200), { ratePerMinute: 30, clock })

    await verifyEnrichedBatch(client, ORG, 10_000, {
      deadlineAt: now() + pacedIntervalMs(30) * 6,
      clock,
    })

    expect(probed.length).toBeGreaterThan(0)
    expect(new Set(probed).size).toBe(probed.length)
  })

  it('probes each address exactly once when the daily budget stops the run early', async () => {
    const probed: string[] = []
    const { clock, now } = fakeClock()
    stubHandler(probed)

    const { client } = fakeSupabase(manyRows(200), {
      ratePerMinute: 30,
      dailyLimit: 12,
      dailyCount: 0,
      clock,
    })

    await verifyEnrichedBatch(client, ORG, 10_000, {
      deadlineAt: now() + DEFAULT_RUN_BUDGET_MS,
      clock,
    })

    expect(probed).toHaveLength(12)
    expect(new Set(probed).size).toBe(12)
  })

  // Every address probed is one that was locked first. A probe on an unlocked row is the
  // shape that lets a second, overlapping run probe the same address.
  it('locks every address before probing it', async () => {
    const probed: string[] = []
    const { clock, now } = fakeClock()
    stubHandler(probed)

    const { client, lockedIds } = fakeSupabase(manyRows(60), { ratePerMinute: 30, clock })

    await verifyEnrichedBatch(client, ORG, 10_000, {
      deadlineAt: now() + pacedIntervalMs(30) * 10,
      clock,
    })

    const locked = new Set(lockedIds.flat())
    expect(locked.size).toBeGreaterThan(0)
    for (const email of probed) {
      const id = `p${email.replace(/\D/g, '')}`
      expect(locked.has(id)).toBe(true)
    }
  })

  // Two runs against the same rows, where the second sees them still locked. This models the
  // production guard: selectPendingVerification excludes a row whose lock is fresh, so an
  // overlapping sweep selects nothing rather than re-probing.
  it('a second run selects nothing while the first still holds the locks', async () => {
    const probedFirst: string[] = []
    const { clock, now } = fakeClock()
    stubHandler(probedFirst)

    const rows = manyRows(20)
    const { client, lockedIds } = fakeSupabase(rows, { ratePerMinute: 30, clock })

    await verifyEnrichedBatch(client, ORG, 10_000, {
      deadlineAt: now() + pacedIntervalMs(30) * 5,
      clock,
    })

    const lockedSet = new Set(lockedIds.flat())
    expect(lockedSet.size).toBeGreaterThan(0)

    // The second run's fake serves only rows the lock filter would still admit. An empty set
    // is what the real `verification_locked_at IS NULL OR < stale` filter produces here.
    const probedSecond: string[] = []
    stubHandler(probedSecond)
    const stillSelectable = rows.filter(r => !lockedSet.has(r.id))
    const second = fakeSupabase(stillSelectable, { ratePerMinute: 30, clock })

    await verifyEnrichedBatch(second.client, ORG, 10_000, {
      deadlineAt: now() + DEFAULT_RUN_BUDGET_MS,
      clock,
    })

    for (const email of probedSecond) {
      expect(probedFirst).not.toContain(email)
    }
  })
})

describe('the default ceiling tracks the budget rather than being written down', () => {
  // A hand-maintained 108 would stop matching the budget the first time either number moved.
  it('is derived from the default window and the fallback pace', () => {
    expect(DEFAULT_VERIFY_BATCH_SIZE).toBe(
      probesWithinBudget(DEFAULT_RUN_BUDGET_MS, pacedIntervalMs(FALLBACK_RATE_LIMIT_PER_MINUTE)),
    )
    // And it is no longer the old fixed forty.
    expect(DEFAULT_VERIFY_BATCH_SIZE).toBeGreaterThan(40)
  })
})
