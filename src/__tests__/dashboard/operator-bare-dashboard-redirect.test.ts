// Bare /dashboard is not a client route for an operator.
//
// resolveViewingOrg falls back to the caller's OWN organisation_id when no ?client= is
// present. For the operator that is doug@margenticos.com's row, which points at
// "ARCHIVE 2026-04 do not use", archived 2026-08-05. So bare /dashboard rendered an
// archived organisation's data dressed as a client dashboard.
//
// ONE BEHAVIOUR, NOT A HEURISTIC: an operator asking for /dashboard with no client named
// gets their own home. The rejected alternative was resolving to the most recently active
// non-archived organisation, which guesses at whose data an operator is looking at.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

let role: string | null = 'operator'
/** Every table the middleware asked for, so a removed read is visible. */
let relationsRead: string[] = []

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) },
    from: (relation: string) => {
      relationsRead.push(relation)
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'eq']) chain[m] = () => chain
      chain.single = async () => ({ data: role === null ? null : { role }, error: null })
      return new Proxy(chain, {
        get(t, p: string) {
          if (p in t) return t[p]
          throw new Error(`fake supabase: .${p}() is not implemented`)
        },
      })
    },
  }),
}))

import { middleware } from '@/middleware'

const req = (url: string) => new NextRequest(new URL(url, 'https://app.test'))

beforeEach(() => { role = 'operator'; relationsRead = [] })

describe('bare /dashboard for an operator', () => {
  it('redirects an operator to their own home', async () => {
    const res = await middleware(req('/dashboard'))
    expect(res.status, 'expected a redirect').toBe(307)
    expect(res.headers.get('location')).toBe('https://app.test/dashboard/operator')
  })

  it('leaves a CLIENT on /dashboard, which is their real home', async () => {
    role = 'client'
    const res = await middleware(req('/dashboard'))
    expect(res.headers.get('location'), 'a client must never be bounced off their own dashboard').toBeNull()
  })

  it('does not touch "view as client", which always carries ?client=', async () => {
    const res = await middleware(req('/dashboard?client=0ed34697-0fa9-4f08-ac15-d3504ac45caf'))
    expect(res.headers.get('location')).toBeNull()
    expect(
      relationsRead,
      'the role was looked up on a path that can never redirect, which is a round trip ' +
      'added to every operator page view for nothing',
    ).toEqual([])
  })

  it('does not fire on nested dashboard routes', async () => {
    const res = await middleware(req('/dashboard/replies'))
    expect(res.headers.get('location')).toBeNull()
    expect(relationsRead).toEqual([])
  })

  it('never redirects operator traffic into a loop through /dashboard/operator', async () => {
    // The redirect target must not itself match the condition, or an operator bounces
    // forever. Cheap to assert and impossible to notice in review.
    const res = await middleware(req('/dashboard/operator'))
    expect(res.headers.get('location')).toBeNull()
  })

  it('reads the role from the database rather than trusting anything on the request', async () => {
    await middleware(req('/dashboard'))
    expect(relationsRead, 'role must come from the users table').toEqual(['users'])
  })
})
