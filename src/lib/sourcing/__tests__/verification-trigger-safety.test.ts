// The four latent bugs that would have gone live the moment anything called verification.
//
// Nothing was broken before 2026-08-25 only because nothing called this code: one operator
// route, no button, no cron, no job type, and every verdict in the database written by a
// manual script that bypasses the trigger entirely. Wiring it up would have activated all
// four at once.
//
// These drive the real verifyEnrichedBatch against a fake Supabase client, because three of
// the four bugs are about which WRITES happen on which path, and a unit test of the pure
// parts cannot see a write that never happened.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { verifyEnrichedBatch, DEFAULT_VERIFY_BATCH_SIZE } from '../verification-trigger'
import { myemailverifierHandler } from '../handlers/adapter-myemailverifier'

const ORG = 'org-1'

interface FakeRow {
  id: string
  email: string | null
  country?: string | null
  verification_attempt_count?: number
}

/** Records every update payload, keyed by the ids it was applied to. */
interface Applied { ids: string[]; payload: Record<string, unknown> }

function fakeSupabase(rows: FakeRow[], opts: { dailyCount?: number; countError?: string } = {}) {
  const applied: Applied[] = []

  const client = {
    from(table: string) {
      if (table !== 'prospects') throw new Error(`unexpected table ${table}`)
      let ids: string[] = []
      // 'rows' = the lockable-prospect select. 'count' = the daily free-tier head count.
      // 'single' = the attempt-count read on the failure path.
      let mode: 'rows' | 'count' | 'single' = 'rows'

      const chain: Record<string, unknown> = {
        select(_cols: string, o?: { count?: string; head?: boolean }) {
          if (o?.head) mode = 'count'
          return chain
        },
        eq(col: string, val: string) { if (col === 'id') ids = [val]; return chain },
        in(_col: string, vals: string[]) { ids = vals; return chain },
        is() { return chain },
        or() { return chain },
        not() { return chain },
        gte() { return chain },
        order() { return chain },
        limit() { return chain },
        maybeSingle() {
          mode = 'single'
          const row = rows.find(r => r.id === ids[0])
          return Promise.resolve({
            data: row ? { verification_attempt_count: row.verification_attempt_count ?? 0 } : null,
            error: null,
          })
        },
        update(payload: Record<string, unknown>) {
          const upd: Record<string, unknown> = {
            eq(col: string, val: string) { if (col === 'id') ids = [val]; return upd },
            in(_c: string, vals: string[]) { ids = vals; return upd },
            then(resolve: (v: unknown) => void) {
              applied.push({ ids: [...ids], payload })
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
            data: rows.map(r => ({ id: r.id, email: r.email, country: r.country ?? null })),
            error: null,
          })
        },
      }
      return chain
    },
  }

  return { client: client as unknown as SupabaseClient, applied }
}

/** Every update payload that touched this prospect. */
const payloadsFor = (applied: Applied[], id: string) =>
  applied.filter(a => a.ids.includes(id)).map(a => a.payload)

const okResult = {
  email: 'a@b.com', status: 'Valid' as const, catch_all: false, disposable_domain: false,
  role_based: false, free_domain: false, greylisted: false, send_eligible: true,
  verified_at: '2026-08-25T00:00:00Z', diagnosis: 'ok',
}

beforeEach(() => vi.restoreAllMocks())
afterEach(() => vi.restoreAllMocks())

describe('BUG 1 — the lock was set before work and cleared only on success', () => {
  it('releases the lock when the probe throws', async () => {
    vi.spyOn(myemailverifierHandler, 'execute').mockRejectedValue(new Error('SMTP refused'))
    const { client, applied } = fakeSupabase([{ id: 'p1', email: 'a@b.com' }])

    await verifyEnrichedBatch(client, ORG, 5)

    const released = payloadsFor(applied, 'p1').some(p => p.verification_locked_at === null)
    expect(released).toBe(true)
  })

  it('releases the lock when the prospect has no email, which never resolves on its own', async () => {
    const { client, applied } = fakeSupabase([{ id: 'p1', email: null }])

    await verifyEnrichedBatch(client, ORG, 5)

    const released = payloadsFor(applied, 'p1').some(p => p.verification_locked_at === null)
    expect(released).toBe(true)
  })

  // Without this, adding the stale reclaim would have been WORSE than the bug it fixed: a
  // permanently bad address would be reclaimed every 30 minutes and re-probed forever.
  it('counts the attempt when the probe throws, so the retry cap can actually bind', async () => {
    vi.spyOn(myemailverifierHandler, 'execute').mockRejectedValue(new Error('SMTP refused'))
    const { client, applied } = fakeSupabase([{ id: 'p1', email: 'a@b.com', verification_attempt_count: 2 }])

    await verifyEnrichedBatch(client, ORG, 5)

    const counted = payloadsFor(applied, 'p1').some(p => p.verification_attempt_count === 3)
    expect(counted).toBe(true)
  })
})

describe('BUG 4 — the daily free-tier counter', () => {
  it('refuses to run when the usage count cannot be read, rather than assuming zero used', async () => {
    const execute = vi.spyOn(myemailverifierHandler, 'execute').mockResolvedValue(okResult)
    const { client } = fakeSupabase([{ id: 'p1', email: 'a@b.com' }], { countError: 'connection lost' })

    const run = await verifyEnrichedBatch(client, ORG, 5)

    // Falling through with `?? 0` told the run the whole day's quota was free, which is the
    // most expensive possible guess to make on an unreadable count.
    expect(run.status).toBe('failed')
    expect(run.error_message).toMatch(/free-tier budget is unknown/)
    expect(execute).not.toHaveBeenCalled()
  })

  it('stops at the daily limit instead of spending past it', async () => {
    const execute = vi.spyOn(myemailverifierHandler, 'execute').mockResolvedValue(okResult)
    // 98 of 100 used, so exactly 2 probes are affordable.
    const { client } = fakeSupabase(
      [1, 2, 3, 4, 5].map(n => ({ id: `p${n}`, email: `p${n}@b.com` })),
      { dailyCount: 98 },
    )

    const run = await verifyEnrichedBatch(client, ORG, 5)

    expect(execute).toHaveBeenCalledTimes(2)
    expect(run.status).toBe('partial')
  })

  it('reports the tier exhausted without probing at all when nothing is left', async () => {
    const execute = vi.spyOn(myemailverifierHandler, 'execute').mockResolvedValue(okResult)
    const { client } = fakeSupabase([{ id: 'p1', email: 'a@b.com' }], { dailyCount: 100 })

    const run = await verifyEnrichedBatch(client, ORG, 5)

    expect(run.status).toBe('free_tier_exhausted')
    expect(execute).not.toHaveBeenCalled()
  })
})

describe('BUG 2 — the default batch has to fit inside the route', () => {
  // The loop sleeps 60000/30 = 2s between addresses, so N addresses cost 2*(N-1) seconds of
  // deliberate waiting before any network time. The old default of 100 is ~198s of sleep
  // inside a route that now declares maxDuration 300.
  it('defaults to a batch whose rate-limit sleep fits well inside the 300s route', () => {
    const sleepSeconds = 2 * (DEFAULT_VERIFY_BATCH_SIZE - 1)
    expect(sleepSeconds).toBeLessThan(150)
    expect(DEFAULT_VERIFY_BATCH_SIZE).toBeLessThan(100)
  })
})

describe('BUG 3 — the outbound probe must be able to give up', () => {
  it('aborts a probe that never answers', async () => {
    // A server that accepts the connection and then says nothing is the exact shape that
    // used to consume the whole invocation.
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) => new Promise((_resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal
        if (!signal) return // no signal means no timeout: the bug
        signal.addEventListener('abort', () => reject(new Error('TimeoutError')))
      }),
    )
    vi.stubEnv('MYEMAILVERIFIER_API_KEY', 'test-key')

    await expect(myemailverifierHandler.execute('slow@example.com')).rejects.toThrow(
      /Email verification failed/,
    )
  }, 30_000)
})
