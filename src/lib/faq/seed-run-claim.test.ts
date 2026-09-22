// The seed-run lock.
//
// WHAT THESE LOCK OUT:
//   - Treating any insert error as "someone else holds the lock". Only 23505, the unique
//     index firing, means that. A dropped connection reported as "already running" would
//     tell the operator to wait for a run that is not happening.
//   - Adopting a lock that is still live. The takeover UPDATE must carry BOTH the
//     state filter and the started_at cutoff; without the cutoff it would steal a claim
//     from a run that is mid-flight, and two Opus calls would write into the same queue.
//   - Recording a refused request as a run. abandonSeedRun deletes; releaseSeedRun does not.
//
// The fake records every filter and refuses to answer an update whose filters it was not
// given, so deleting one is a failure rather than a silently wider query.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { claimSeedRun, releaseSeedRun, abandonSeedRun, STALE_CLAIM_MS } from './seed-run-claim'

const ORG = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'

interface FakeOptions {
  insertError?: { code?: string; message: string } | null
  /** Rows the takeover UPDATE's own filters would actually match. */
  staleRowMatches?: boolean
  liveHolderStartedAt?: string | null
}

function makeFake(opts: FakeOptions = {}) {
  const recorded = {
    inserted: [] as Array<Record<string, unknown>>,
    updateFilters: [] as Array<Record<string, unknown>>,
    updateValues: [] as Array<Record<string, unknown>>,
    deletedIds: [] as string[],
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const client = {
    from(table: string) {
      if (table !== 'faq_seed_runs') throw new Error(`fake: unexpected table ${table}`)

      return {
        insert(values: Record<string, unknown>) {
          recorded.inserted.push(values)
          return {
            select: () => ({
              single: async () =>
                opts.insertError
                  ? { data: null, error: opts.insertError }
                  : { data: { id: 'run-new' }, error: null },
            }),
          }
        },

        update(values: Record<string, unknown>) {
          const filters: Record<string, unknown> = {}
          recorded.updateValues.push(values)
          const chain: any = {
            eq: (col: string, val: unknown) => { filters[col] = val; return chain },
            lt: (col: string, val: unknown) => { filters[`lt:${col}`] = val; return chain },
            select: async () => {
              recorded.updateFilters.push({ ...filters })
              // A takeover is only legitimate when BOTH narrowing filters were applied.
              // Modelling that here is the point: an UPDATE missing the cutoff really
              // would match a live row in Postgres, so the fake must match one too.
              const hasCutoff = typeof filters['lt:started_at'] === 'string'
              const hasState = filters.state === 'running'
              const matched = hasCutoff
                ? (opts.staleRowMatches ?? false)
                : hasState   // no cutoff: every running row matches, live ones included
              return { data: matched ? [{ id: 'run-stale' }] : [], error: null }
            },
          }
          // releaseSeedRun ends on .eq() with no .select(), so awaiting the chain must work.
          chain.then = (resolve: (v: unknown) => void) => {
            recorded.updateFilters.push({ ...filters })
            resolve({ error: null })
          }
          return chain
        },

        select() {
          const filters: Record<string, unknown> = {}
          const chain: any = {
            eq: (col: string, val: unknown) => { filters[col] = val; return chain },
            maybeSingle: async () => ({
              data: opts.liveHolderStartedAt ? { started_at: opts.liveHolderStartedAt } : null,
              error: null,
            }),
          }
          return chain
        },

        delete() {
          return { eq: async (_col: string, id: string) => { recorded.deletedIds.push(id); return { error: null } } }
        },
      }
    },
  } as unknown as SupabaseClient
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return { client, recorded }
}

describe('claimSeedRun', () => {
  beforeEach(() => vi.clearAllMocks())

  it('wins the lock when the insert succeeds', async () => {
    const { client, recorded } = makeFake()

    const result = await claimSeedRun(client, ORG, 'user-1')

    expect(result).toEqual({ kind: 'claimed', runId: 'run-new', tookOverStaleClaim: false })
    expect(recorded.inserted[0]).toMatchObject({
      organisation_id: ORG, state: 'running', started_by_user_id: 'user-1',
    })
  })

  it('reports already_running when the unique index fires and no claim is stale', async () => {
    const { client } = makeFake({
      insertError: { code: '23505', message: 'duplicate key' },
      staleRowMatches: false,
      liveHolderStartedAt: '2026-09-21T10:00:00.000Z',
    })

    const result = await claimSeedRun(client, ORG, 'user-1')

    expect(result).toEqual({ kind: 'already_running', startedAt: '2026-09-21T10:00:00.000Z' })
  })

  it('adopts a claim older than the stale threshold', async () => {
    const { client, recorded } = makeFake({
      insertError: { code: '23505', message: 'duplicate key' },
      staleRowMatches: true,
    })

    const result = await claimSeedRun(client, ORG, 'user-2')

    expect(result).toEqual({ kind: 'claimed', runId: 'run-stale', tookOverStaleClaim: true })

    const takeover = recorded.updateFilters.at(-1)!
    expect(takeover.organisation_id).toBe(ORG)
    expect(takeover.state).toBe('running')
    // The cutoff is what separates an abandoned claim from a live one.
    const cutoff = Date.parse(takeover['lt:started_at'] as string)
    expect(Date.now() - cutoff).toBeGreaterThanOrEqual(STALE_CLAIM_MS - 5_000)
    expect(Date.now() - cutoff).toBeLessThanOrEqual(STALE_CLAIM_MS + 5_000)
  })

  it('throws rather than reporting a busy lock when the insert fails for any other reason', async () => {
    const { client } = makeFake({ insertError: { code: '08006', message: 'connection failure' } })

    // Reporting this as "already running" would send the operator away to wait for a run
    // that does not exist.
    await expect(claimSeedRun(client, ORG, 'user-1')).rejects.toThrow(/could not claim the run lock/)
  })
})

describe('releaseSeedRun and abandonSeedRun', () => {
  it('release records the outcome against the run it holds', async () => {
    const { client, recorded } = makeFake()

    await releaseSeedRun(client, 'run-1', { state: 'completed', candidatesCreated: 9 })

    expect(recorded.updateValues[0]).toMatchObject({ state: 'completed', candidates_created: 9 })
    expect(recorded.updateFilters[0]).toMatchObject({ id: 'run-1' })
  })

  it('abandon deletes, so a refused request never appears as a run', async () => {
    const { client, recorded } = makeFake()

    await abandonSeedRun(client, 'run-1')

    expect(recorded.deletedIds).toEqual(['run-1'])
    expect(recorded.updateValues).toEqual([])
  })
})
