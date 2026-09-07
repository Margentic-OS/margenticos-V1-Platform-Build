// The sidebar and the page must resolve the SAME organisation.
//
// THE DEFECT THIS EXISTS FOR. (client)/layout.tsx read users.organisation_id directly and
// never called resolveViewingOrg, because a Next.js App Router layout receives `params`
// but never `searchParams` and so cannot see `?client=`. The prospect-tiers page calls
// resolveViewingOrg twice. So under an operator's "View as client" the sidebar counted one
// organisation while the page rendered another.
//
// Measured on the live workspace: doug@margenticos.com has organisation_id pointing at
// "MargenticOS (archived April 2026)", whose roster count is 0, while the page rendered
// "MargenticOS" with 103. Two organisations whose names differ only by a suffix, which is
// why every symptom pointed at the nav gate instead.
//
// This test pins the agreement itself rather than either side of it: it asserts the
// organisation the counts are READ FOR is the one resolveViewingOrg returns, which is the
// same function the page uses. Point the route at users.organisation_id again and it goes
// red.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const OPERATOR_OWN_ORG = '74243c62-f42d-4f3f-b93e-bd5e51f0b6c0' // archived MargenticOS
const VIEWED_ORG = '0ed34697-0fa9-4f08-ac15-d3504ac45caf' // live MargenticOS

/** Every organisation_id the service client was filtered by. */
const orgIdsQueried: string[] = []

let currentUserRole = 'operator'

function countChain() {
  const c: Record<string, unknown> = {}
  for (const method of ['select', 'in', 'not', 'or']) c[method] = vi.fn(() => c)
  c.eq = vi.fn((column: string, value: string) => {
    if (column === 'organisation_id') orgIdsQueried.push(value)
    return c
  })
  ;(c as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    resolve({ count: 7, error: null })
  return c
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: { organisation_id: OPERATOR_OWN_ORG, role: currentUserRole },
            error: null,
          }),
        }),
      }),
    }),
  }),
}))

vi.mock('@/lib/supabase/service-role', () => ({
  createServiceRoleClient: async () => ({ from: () => countChain() }),
}))

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

async function callRoute(clientParam?: string) {
  const { GET } = await import('../nav-counts/route')
  const { NextRequest } = await import('next/server')
  const url = clientParam
    ? `http://localhost/api/dashboard/client/nav-counts?client=${clientParam}`
    : 'http://localhost/api/dashboard/client/nav-counts'
  return GET(new NextRequest(url))
}

beforeEach(() => {
  orgIdsQueried.length = 0
  currentUserRole = 'operator'
})

describe('nav counts resolve the organisation being viewed', () => {
  it('counts the VIEWED organisation for an operator, not the operator own organisation', async () => {
    await callRoute(VIEWED_ORG)

    expect(orgIdsQueried.length).toBeGreaterThan(0)
    expect(new Set(orgIdsQueried)).toEqual(new Set([VIEWED_ORG]))
    expect(orgIdsQueried).not.toContain(OPERATOR_OWN_ORG)
  })

  it('falls back to the operator own organisation when no client param is present', async () => {
    await callRoute()
    expect(new Set(orgIdsQueried)).toEqual(new Set([OPERATOR_OWN_ORG]))
  })

  // resolveViewingOrg pins a client to their own organisation whatever the URL says. The
  // route adds no rule of its own, so this is the same guarantee the page has.
  it('IGNORES the client param for a client, so it cannot read another organisation', async () => {
    currentUserRole = 'client'
    await callRoute(VIEWED_ORG)

    expect(new Set(orgIdsQueried)).toEqual(new Set([OPERATOR_OWN_ORG]))
    expect(orgIdsQueried).not.toContain(VIEWED_ORG)
  })

  it('returns both counts', async () => {
    const res = await callRoute(VIEWED_ORG)
    const json = await res.json()
    expect(json).toEqual({ pendingProspectsCount: 7, rosterProspectsCount: 7 })
  })
})

describe('the layout no longer queries prospects itself', () => {
  // Structural, and deliberately so: the layout physically cannot resolve a different
  // organisation from the shared module if it does not build the query at all. Stated as a
  // limit rather than over-trusted: this proves the duplication is gone, not that the
  // remaining query is right. The behavioural tests above cover that.
  it('has no direct prospects query left in the client layout', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync('src/app/dashboard/(client)/layout.tsx', 'utf8')

    expect(source).toContain('getProspectNavCounts')
    expect(source).not.toContain(".from('prospects')")
  })
})
