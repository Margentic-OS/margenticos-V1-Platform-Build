// The sidebar and the page must resolve the SAME organisation.
//
// THE DEFECT THIS EXISTS FOR. (client)/layout.tsx read users.organisation_id directly and
// never called resolveViewingOrg, because a Next.js App Router layout receives `params`
// but never `searchParams` and so cannot see `?client=`. So under an operator's
// "View as client" the sidebar counted one organisation while the page rendered another.
//
// THE 2026-09-08 CORRECTION. This header used to assert that "the prospect-tiers page calls
// resolveViewingOrg twice", and the c9b04f2 commit message said the same. IT WAS NEVER TRUE.
// The page called it ONCE, passing a literal `undefined` where the client param belongs, and
// did not declare searchParams at all. Traced through every commit that touched the file:
// the `undefined` was there from 2026-08-10, including at c9b04f2 itself. The sidebar was
// fixed against an assumption that the page was already correct, which is why fixing one
// resolver left the bug alive on the route the fix was written for.
//
// So this file now pins BOTH routes. The scope is wider than the filename.
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

/** How many of the two counts were given an abort signal. See countChain. */
let boundedReads = 0

let currentUserRole = 'operator'

function countChain() {
  const c: Record<string, unknown> = {}
  for (const method of ['select', 'in', 'not', 'or']) c[method] = vi.fn(() => c)
  // HONOURED, NOT SWALLOWED. service_role carries no statement_timeout, so both of these
  // counts are bounded in the source. A fake that quietly returned the chain from an
  // unimplemented .abortSignal() would pass whether or not the ceiling is applied.
  c.abortSignal = vi.fn((signal: AbortSignal) => {
    if (!(signal instanceof AbortSignal)) throw new Error('abortSignal called with no signal')
    boundedReads += 1
    return c
  })
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
  boundedReads = 0
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
  // Added 2026-09-07 alongside the read ceiling. service_role has no statement_timeout in
  // the database (read back from pg_roles), so these two counts were the reads behind the
  // sidebar with no ceiling on either side of the connection: a hang held the nav until
  // the 300s function timeout cut the response, which the client sees as a blank page.
  it('bounds both prospect counts with an abort signal', async () => {
    await callRoute(VIEWED_ORG)
    expect(
      boundedReads,
      'a prospect nav count ran unbounded. Nothing else limits it: service_role has no ' +
      'statement_timeout, so the only remaining ceiling is the 300s function timeout.',
    ).toBe(2)
  })

  it('has no direct prospects query left in the client layout', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync('src/app/dashboard/(client)/layout.tsx', 'utf8')

    expect(source).toContain('getProspectNavCounts')
    expect(source).not.toContain(".from('prospects')")
  })
})


// ---------------------------------------------------------------------------
// The prospect-tiers route and page, added 2026-09-08.
//
// There were THREE resolvers on that one page, not two: resolveViewingOrg with a literal
// `undefined`, getClientProspectTiers resolving users.organisation_id for itself, and the
// sidebar. The second is the one that mattered, because it queries through a SERVICE-ROLE
// client, so RLS could never catch the disagreement.
// ---------------------------------------------------------------------------

/** Every organisation id getClientProspectTiers was asked to read. */
const tierOrgIdsRequested: string[] = []

vi.mock('@/lib/prospect-tiers-data', () => ({
  getClientProspectTiers: vi.fn(async (clientOrgId: string) => {
    tierOrgIdsRequested.push(clientOrgId)
    return []
  }),
}))

async function callTiersRoute(clientParam?: string) {
  const { GET } = await import('../prospect-tiers/route')
  const { NextRequest } = await import('next/server')
  const url = clientParam
    ? `http://localhost/api/dashboard/client/prospect-tiers?client=${clientParam}`
    : 'http://localhost/api/dashboard/client/prospect-tiers'
  return GET(new NextRequest(url))
}

describe('prospect tiers resolve the organisation being viewed', () => {
  beforeEach(() => {
    tierOrgIdsRequested.length = 0
    currentUserRole = 'operator'
  })

  it('reads the VIEWED organisation for an operator, not the operator own organisation', async () => {
    await callTiersRoute(VIEWED_ORG)

    expect(tierOrgIdsRequested).toEqual([VIEWED_ORG])
    expect(tierOrgIdsRequested).not.toContain(OPERATOR_OWN_ORG)
  })

  it('falls back to the operator own organisation when no client param is present', async () => {
    await callTiersRoute()
    expect(tierOrgIdsRequested).toEqual([OPERATOR_OWN_ORG])
  })

  // The whole reason honouring ?client= here is safe. resolveViewingOrg is still the only
  // place the question is decided, so the route widens nothing for a client.
  it('IGNORES the client param for a client, so it cannot read another organisation', async () => {
    currentUserRole = 'client'
    await callTiersRoute(VIEWED_ORG)

    expect(tierOrgIdsRequested).toEqual([OPERATOR_OWN_ORG])
    expect(tierOrgIdsRequested).not.toContain(VIEWED_ORG)
  })
})

describe('nothing downstream resolves the organisation a second time', () => {
  // Structural, and stated as a limit: this proves the second resolver is GONE, not that
  // the remaining one is right. The behavioural tests above cover that. It is here because
  // a data module that resolves its own organisation cannot be caught by any assertion
  // about the caller, and it queries through service_role, so RLS will not catch it either.
  it('getClientProspectTiers takes an org id and does not read users.organisation_id', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync('src/lib/prospect-tiers-data.ts', 'utf8')

    expect(source).toContain('clientOrgId: string')
    expect(
      source,
      'getClientProspectTiers resolved the organisation itself again. That is a SECOND ' +
      'resolver, and it reads through a service-role client so RLS cannot catch it.',
    ).not.toContain(".from('users')")
  })

  it('the prospect-tiers page passes the client param through to resolveViewingOrg', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync('src/app/dashboard/(client)/prospect-tiers/page.tsx', 'utf8')

    expect(source).toContain('resolveViewingOrg(supabase, user, clientParam)')
    expect(
      source,
      'the page passed a literal `undefined` where ?client= belongs, which is the ' +
      'original defect. It must read searchParams.',
    ).not.toContain('user, undefined')
  })
})
