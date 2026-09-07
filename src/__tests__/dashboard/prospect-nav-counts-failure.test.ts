// A refused, timed-out or failed nav count must leave a row behind it.
//
// `count ?? 0` erases the difference between "this organisation has no roster" and "the
// read did not answer". postgrest-js never throws, so nothing upstream could tell them
// apart either. The counts still degrade to zero, because a sidebar that renders beats a
// sidebar that is right, but a failure now writes a row that MON-032 reads.
//
// THE FAKE THROWS ON ANY METHOD IT DOES NOT IMPLEMENT. A fake that silently returns the
// chain from .abortSignal() would pass whether or not the timeout is applied, which is
// how three filters in this codebase were found untested by mutation rather than by
// reading.

import { describe, it, expect, beforeEach, vi } from 'vitest'

const recorded: Array<Record<string, unknown>> = []
vi.mock('@/lib/dashboard/record-dashboard-failure', () => ({
  recordDashboardFailure: async (f: Record<string, unknown>) => { recorded.push(f) },
}))

import { getProspectNavCounts } from '@/lib/dashboard/prospect-nav-counts'
import type { ServiceRoleClient } from '@/lib/supabase/service-role'

/** Which queries received an abort signal, in call order. */
let signalsSeen: boolean[] = []
/** Results handed back, one per query in order. */
let results: Array<{ count: number | null; error: { message: string } | null }> = []

function fakeClient(): ServiceRoleClient {
  let queryIndex = -1

  const makeChain = () => {
    queryIndex += 1
    const myIndex = queryIndex
    signalsSeen[myIndex] = false

    const chain: Record<string, unknown> = {}
    const passthrough = ['select', 'eq', 'in', 'not', 'or']
    for (const m of passthrough) chain[m] = () => chain

    chain.abortSignal = (signal: AbortSignal) => {
      expect(signal, 'abortSignal called with no signal').toBeInstanceOf(AbortSignal)
      signalsSeen[myIndex] = true
      return chain
    }

    chain.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(results[myIndex]).then(onFulfilled)

    return new Proxy(chain, {
      get(target, prop: string) {
        if (prop in target) return target[prop]
        throw new Error(`fake supabase: .${prop}() is not implemented and was not honoured`)
      },
    })
  }

  return { from: () => makeChain() } as unknown as ServiceRoleClient
}

beforeEach(() => {
  recorded.length = 0
  signalsSeen = []
  results = [
    { count: 3, error: null },
    { count: 7, error: null },
  ]
})

describe('getProspectNavCounts', () => {
  it('bounds BOTH reads with an abort signal', async () => {
    await getProspectNavCounts(fakeClient(), 'org-1')
    expect(
      signalsSeen,
      'a nav count read ran with no ceiling. service_role has no statement_timeout, so ' +
      'that read can hang until the function times out and the sidebar never renders.',
    ).toEqual([true, true])
  })

  it('returns the counts when both reads answer', async () => {
    const counts = await getProspectNavCounts(fakeClient(), 'org-1')
    expect(counts).toEqual({ pendingProspectsCount: 3, rosterProspectsCount: 7 })
    expect(recorded, 'a healthy read must not write a failure row').toEqual([])
  })

  it('records a failure when a read is refused, and still returns a renderable zero', async () => {
    results = [
      { count: null, error: { message: 'permission denied for table prospects' } },
      { count: 7, error: null },
    ]
    const counts = await getProspectNavCounts(fakeClient(), 'org-1')

    expect(counts.pendingProspectsCount, 'the sidebar must still render').toBe(0)
    expect(counts.rosterProspectsCount).toBe(7)
    expect(
      recorded,
      'a refused nav count wrote no row, so the failure reaches no monitor and nobody ' +
      'but the client ever knows the badge was wrong',
    ).toHaveLength(1)
    expect(recorded[0]).toMatchObject({
      kind: 'read',
      source: 'prospect-nav-counts:pending',
      organisationId: 'org-1',
    })
  })

  it('records a failure when a read times out', async () => {
    results = [
      { count: 3, error: null },
      { count: null, error: { message: 'AbortError: Request was aborted (timeout or manual cancellation)' } },
    ]
    await getProspectNavCounts(fakeClient(), 'org-1')
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({ source: 'prospect-nav-counts:roster' })
  })

  it('records BOTH when both fail, rather than stopping at the first', async () => {
    results = [
      { count: null, error: { message: 'a' } },
      { count: null, error: { message: 'b' } },
    ]
    await getProspectNavCounts(fakeClient(), 'org-1')
    expect(recorded).toHaveLength(2)
  })
})
