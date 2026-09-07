// The one route a client can use to write to the monitor board, and everything it refuses
// to take from the caller.
//
// This feeds MON-032, so anything a caller can put in a row here it can put on the
// operator's board. The body is therefore nearly powerless: kind and source are forced,
// the organisation comes from the caller's own user row, and route and digest are the only
// two accepted values.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const recorded: Array<Record<string, unknown>> = []
vi.mock('@/lib/dashboard/record-dashboard-failure', () => ({
  recordDashboardFailure: async (f: Record<string, unknown>) => { recorded.push(f) },
}))

let user: { id: string } | null = { id: 'u1' }
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user }, error: null }) },
    from: () => {
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'eq']) chain[m] = () => chain
      chain.single = async () => ({ data: { organisation_id: 'org-from-db' }, error: null })
      return new Proxy(chain, {
        get(t, p: string) {
          if (p in t) return t[p]
          throw new Error(`fake supabase: .${p}() is not implemented`)
        },
      })
    },
  }),
}))

import { POST } from '@/app/api/dashboard/failure/route'

const post = (body: unknown) =>
  POST(new NextRequest('https://app.test/api/dashboard/failure', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))

beforeEach(() => { recorded.length = 0; user = { id: 'u1' } })

describe('POST /api/dashboard/failure', () => {
  it('refuses an unauthenticated caller', async () => {
    user = null
    const res = await post({ route: '/dashboard' })
    expect(res.status).toBe(401)
    expect(recorded, 'an unauthenticated caller wrote to the monitor board').toEqual([])
  })

  it('records a render failure for an authenticated caller', async () => {
    await post({ route: '/dashboard', digest: 'abc123' })
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({
      kind: 'render',
      source: 'dashboard-error-boundary',
      route: '/dashboard',
      digest: 'abc123',
    })
  })

  it('takes the organisation from the database, never from the body', async () => {
    await post({ route: '/dashboard', organisationId: 'someone-elses-org', organisation_id: 'someone-elses-org' })
    expect(
      recorded[0].organisationId,
      'a caller could attribute a failure to another organisation and make their ' +
      'dashboard look broken on the operator board',
    ).toBe('org-from-db')
  })

  it('forces kind to render, so a caller cannot fake a read failure', async () => {
    await post({ route: '/dashboard', kind: 'read' })
    expect(recorded[0].kind).toBe('render')
  })

  it('forces the source, so rows stay groupable', async () => {
    await post({ route: '/dashboard', source: 'anything-i-like' })
    expect(recorded[0].source).toBe('dashboard-error-boundary')
  })

  it('caps route and digest length', async () => {
    await post({ route: 'x'.repeat(5000), digest: 'y'.repeat(5000) })
    expect((recorded[0].route as string).length).toBeLessThanOrEqual(200)
    expect((recorded[0].digest as string).length).toBeLessThanOrEqual(100)
  })

  it('still records when the boundary could not send a body', async () => {
    // A boundary firing during a bad network moment may well fail to serialise a body.
    // The fact that it fired is the signal; losing the report because the body was
    // missing would drop exactly the incidents this exists for.
    const res = await POST(new NextRequest('https://app.test/api/dashboard/failure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json at all',
    }))
    expect(res.status).toBe(200)
    expect(recorded).toHaveLength(1)
    expect(recorded[0].route).toBe('/dashboard')
  })
})
