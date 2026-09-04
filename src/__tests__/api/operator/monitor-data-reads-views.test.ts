import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MONITORS } from '@/app/api/cron/monitor-sweep/monitors'

/**
 * WHY THIS FILE EXISTS: IT TESTS THE WIRING, NOT THE RESULT.
 *
 * The operator dashboard displayed monitor_events.created_at under the label
 * "Last run". The sweep writes a row only on a state TRANSITION, so between
 * transitions the timestamp and the detail froze. Measured on production
 * 2026-09-04: a median gap of about 10 days across 23 monitors, nine over three
 * weeks, while the sweep ran every 15 minutes and was healthy.
 *
 * The fix makes /api/operator/monitor-data read the live mon_* views. The danger
 * with a fix like that is a test suite full of assertions ABOUT THE RESULT: give
 * the route a fake that returns plausible rows and every such test stays green
 * whether or not the route ever asks for a view. A previous session watched 51
 * tests stay green after an entire sweep was deleted from a route, for exactly
 * that reason.
 *
 * So these tests assert what the route ASKED THE DATABASE FOR. Delete the view
 * read from the route and they go red, because the recorded table list stops
 * containing the views. That is the mutation this file is built to catch.
 *
 * The fake THROWS on any method it does not implement rather than returning the
 * chain. A fake that silently accepts .limit() or .single() it never honours is
 * how three filters in this codebase were found untested by mutation rather than
 * by reading.
 */

const cookieStore = { getAll: () => [], set: () => {} }
vi.mock('next/headers', () => ({ cookies: async () => cookieStore }))

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'operator-1' } }, error: null }) },
  }),
}))

/** Every table or view name the route asked for, in order. */
let requestedRelations: string[] = []

/** When set, the fake makes this one view fail, to prove failures are reported. */
let failingView: string | null = null

/** Rows the fake returns per relation. */
function resultFor(relation: string): { data: unknown; error: unknown } {
  if (relation === 'users') return { data: { role: 'operator' }, error: null }
  if (relation === 'monitor_checks') {
    return {
      data: [{ code: 'MON-001', title: 't', description: 'd', category: 'liveness', is_scheduled: true }],
      error: null,
    }
  }
  if (relation === 'monitor_events') return { data: [], error: null }
  if (/^mon_\d+$/.test(relation)) {
    return {
      data: { check_code: relation.toUpperCase().replace('_', '-'), state: 'OK', detail: 'live detail', last_run: '2026-09-04T22:00:00Z' },
      error: null,
    }
  }
  throw new Error(`fake supabase: nothing configured for relation "${relation}"`)
}

function chainFor(relation: string) {
  const result =
    relation === failingView
      ? { data: null, error: { message: 'permission denied' } }
      : resultFor(relation)
  const implemented: Record<string, unknown> = {
    select: () => chain,
    order: () => chain,
    limit: () => chain,
    eq: () => chain,
    single: async () => result,
    maybeSingle: async () => result,
    // Awaiting the chain directly is how the route reads monitor_checks and
    // monitor_events, which end at .order() rather than .single().
    then: (resolve: (v: unknown) => unknown) => resolve(result),
  }

  const chain: unknown = new Proxy(implemented, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      // The rule from CLAUDE.md: a fake that silently ignores a call it does not
      // implement cannot test the thing that call was doing.
      throw new Error(`fake supabase: chain method "${String(prop)}" is not implemented on ${relation}`)
    },
  })

  return chain
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (relation: string) => {
      requestedRelations.push(relation)
      return chainFor(relation)
    },
  }),
}))

import { GET } from '@/app/api/operator/monitor-data/route'

function fakeRequest() {
  return {} as unknown as Parameters<typeof GET>[0]
}

describe('monitor-data route reads the live views', () => {
  beforeEach(() => {
    requestedRelations = []
    failingView = null
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service'
  })

  it('asks the database for EVERY view in the monitor registry', async () => {
    await GET(fakeRequest())

    const expected = MONITORS.map(([, view]) => view)

    // Guard the guard: an empty registry would make this pass vacuously.
    expect(expected.length, 'the monitor registry is empty, so this test proves nothing')
      .toBeGreaterThan(0)

    const missing = expected.filter(view => !requestedRelations.includes(view))

    expect(
      missing,
      `the route never read these views, so the dashboard would show frozen values for them: ${missing.join(', ')}`,
    ).toEqual([])
  })

  it('still reads monitor_events, which is where acknowledgement and history live', async () => {
    await GET(fakeRequest())
    expect(requestedRelations).toContain('monitor_events')
  })

  it('returns a live reading keyed by check code, carrying state, detail and last_run', async () => {
    const response = await GET(fakeRequest())
    const body = await response.json()

    for (const [code] of MONITORS) {
      expect(body.live[code], `no live reading returned for ${code}`).toBeDefined()
    }

    expect(body.live['MON-001'].state).toBe('OK')
    expect(body.live['MON-001'].detail).toBe('live detail')
    expect(body.live['MON-001'].last_run).toBe('2026-09-04T22:00:00Z')
    expect(body.checkedAt, 'checkedAt is what the dashboard shows for read-time views').toBeTruthy()
  })

  it('reports a failed view read instead of silently falling back', async () => {
    // A silent fallback to the stored event would rebuild the original defect and
    // be invisible, which is the whole failure mode being fixed.
    const [failingCode, failingViewName] = MONITORS[0]
    failingView = failingViewName

    const response = await GET(fakeRequest())
    const body = await response.json()

    expect(body.liveErrors[failingCode]).toBe('permission denied')
    expect(body.live[failingCode], 'a failed read must not produce a live reading').toBeUndefined()

    // Every other view still reported normally, so one bad view does not blind the board.
    expect(Object.keys(body.live)).toHaveLength(MONITORS.length - 1)
  })
})
