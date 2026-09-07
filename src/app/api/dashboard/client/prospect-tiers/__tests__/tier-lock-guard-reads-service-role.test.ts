// The tier lock guard must read through a service-role client, not the session client.
//
// prospects carries two policies that disagree:
//   clients_read_own_prospects_denied     SELECT  USING (false)
//   clients_update_own_prospect_review    UPDATE  USING (organisation_id = get_my_organisation_id())
//
// A client session therefore cannot READ this table but CAN WRITE it. Through the session
// client the lock SELECT returned [] for every real client, with no error, because an RLS
// denial is not an error. The 409 could never fire and the UPDATE below it succeeded.
// A client could sanction or unsanction a tier already uploaded and sending: 95 prospects
// on the live organisation.
//
// THE FAKE HERE IS THE WHOLE POINT. The session client returns [] for prospects, exactly
// as RLS makes it. The service client returns a locked row. So the test can only pass if
// the route reads through the service client. Reverting that one word turns the 409 back
// into a 200 and this test goes red, which is the mutation that matters.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const sessionProspectSelect = vi.fn()
const serviceProspectSelect = vi.fn()
const updateSpy = vi.fn()

function chain(result: unknown) {
  const c: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'or', 'in', 'limit', 'update']) {
    c[method] = vi.fn(() => c)
  }
  // Awaiting the builder resolves to the result, matching PostgREST.
  ;(c as { then: unknown }).then = (resolve: (v: unknown) => unknown) => resolve(result)
  return c
}

// The session client: prospects reads come back EMPTY, never an error. That is RLS.
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    from: (table: string) => {
      if (table === 'users') {
        const c = chain({ data: { organisation_id: 'org-1' }, error: null })
        ;(c as { single: unknown }).single = async () => ({
          data: { organisation_id: 'org-1' },
          error: null,
        })
        return c
      }
      if (table === 'prospects') {
        sessionProspectSelect()
        const c = chain({ data: [], error: null })
        ;(c as { update: unknown }).update = (...args: unknown[]) => {
          updateSpy(...args)
          return chain({ data: [], error: null })
        }
        return c
      }
      return chain({ data: null, error: null })
    },
  }),
}))

// The service client: it can actually see the uploaded prospect.
vi.mock('@/lib/supabase/service-role', () => ({
  createServiceRoleClient: async () => ({
    from: (table: string) => {
      if (table === 'prospects') {
        serviceProspectSelect()
        return chain({ data: [{ id: 'already-uploaded' }], error: null })
      }
      return chain({ data: null, error: null })
    },
  }),
}))

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

beforeEach(() => {
  sessionProspectSelect.mockClear()
  serviceProspectSelect.mockClear()
  updateSpy.mockClear()
})

// sanction exposes POST, unsanction exposes DELETE. Reaching for the verb each route
// actually exports, rather than assuming they match, is the difference between testing the
// guard and testing an import.
async function callRoute(which: 'sanction' | 'unsanction') {
  const { NextRequest } = await import('next/server')
  const handler =
    which === 'sanction'
      ? (await import('../[tier]/sanction/route')).POST
      : (await import('../[tier]/unsanction/route')).DELETE
  const req = new NextRequest('http://localhost/api/dashboard/client/prospect-tiers/tier_1/x', {
    method: which === 'sanction' ? 'POST' : 'DELETE',
  })
  return handler(req, { params: Promise.resolve({ tier: 'tier_1' }) })
}

describe.each(['sanction', 'unsanction'] as const)('%s: the tier lock guard', which => {
  it('refuses with 409 when a prospect is already uploaded', async () => {
    const res = await callRoute(which)
    expect(res.status).toBe(409)
  })

  it('reads the lock through the service client, which is the only one that can see it', async () => {
    await callRoute(which)
    expect(serviceProspectSelect).toHaveBeenCalled()
  })

  it('does not write when the tier is locked', async () => {
    await callRoute(which)
    expect(updateSpy).not.toHaveBeenCalled()
  })
})
