// The operator edit path for organisations.name.
//
// WHY THIS FIELD IS WORTH A TEST FILE. It is not a display label. organisations.name is the
// SECOND LINE OF THE SIGN-OFF BLOCK on every email this platform sends: the messaging
// agent's preflight reads it, and a validator enforces its presence at the end of every
// body. Until 2026-09-03 it was typed once at client creation and had no edit path at all,
// so a typo there was a typo under every email with no way to correct it from the UI.
//
// The tests that matter here are the REFUSALS. An edit path that can blank the field turns
// one click into a generation run that fails preflight days later, a long way from the
// action that caused it.
//
// No real client name appears anywhere below. The values are neutral placeholders on
// purpose: this change is about company names, which makes it the highest-risk place in the
// repository to leak one into a fixture.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const ORG = 'org-under-test'
const A_NAME = 'Name One Ltd'
const A_LONGER_NAME = 'Name One Limited'

let role: string | null = 'operator'
let updates: Array<{ table: string; payload: Record<string, unknown>; id: string }> = []
let updateError: { message: string } | null = null
const redirects: string[] = []

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    redirects.push(to)
    throw new Error(`REDIRECT:${to}`)
  },
}))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

function makeSessionClient() {
  return {
    auth: {
      getUser: async () => ({ data: { user: role === null ? null : { id: 'user-1' } } }),
    },
    from(table: string) {
      if (table === 'users') {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          single: async () => ({ data: role ? { role } : null, error: null }),
        }
        return chain
      }
      if (table === 'organisations') {
        return {
          update(payload: Record<string, unknown>) {
            const upd: Record<string, unknown> = {
              eq(col: string, val: string) {
                // HONOURED. A write that forgot its .eq('id', ...) would rename every
                // organisation on the platform, and a fake that swallowed the filter could
                // not tell the difference.
                if (col !== 'id') throw new Error(`fake: unexpected filter ${col}`)
                updates.push({ table, payload, id: val })
                return upd
              },
              then(resolve: (v: unknown) => void) {
                resolve({ error: updateError })
              },
            }
            return upd
          },
        }
      }
      throw new Error(`fake: unexpected table ${table}`)
    },
  } as never
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => makeSessionClient()),
}))
vi.mock('@/lib/supabase/service-role', () => ({
  createServiceRoleClient: vi.fn(async () => makeSessionClient()),
}))

import { updateOrganisationName } from '../actions'

beforeEach(() => {
  role = 'operator'
  updates = []
  updateError = null
  redirects.length = 0
  vi.clearAllMocks()
})

describe('updateOrganisationName', () => {
  it('writes the trimmed name to the one organisation named', async () => {
    const result = await updateOrganisationName(ORG, `  ${A_LONGER_NAME}  `)

    expect(result).toEqual({})
    expect(updates).toEqual([
      { table: 'organisations', payload: { name: A_LONGER_NAME }, id: ORG },
    ])
  })

  it('refuses an empty name rather than clearing the sign-off line', async () => {
    // organisations.name is nullable and the messaging agent fails preflight without it.
    // Allowing the field to be emptied from the UI converts one click into a generation
    // failure some days later.
    for (const blank of ['', '   ', '\t\n']) {
      const result = await updateOrganisationName(ORG, blank)
      expect(result.error, `blank input ${JSON.stringify(blank)} was accepted`).toBeTruthy()
      expect(result.error).toContain('cannot be empty')
    }
    expect(updates, 'a refused edit must not reach the database').toEqual([])
  })

  it('refuses a name long enough to be a paste accident', async () => {
    const result = await updateOrganisationName(ORG, 'x'.repeat(121))
    expect(result.error).toContain('120 characters')
    expect(updates).toEqual([])
  })

  it('accepts a name exactly at the limit, so the boundary is not off by one', async () => {
    const result = await updateOrganisationName(ORG, 'x'.repeat(120))
    expect(result).toEqual({})
    expect(updates).toHaveLength(1)
  })

  it('validates BEFORE authenticating, so a bad input never depends on session state', async () => {
    // Ordering matters only because it is cheap to get wrong: the refusal must be the same
    // refusal whether or not the session lookup succeeds.
    role = null
    const result = await updateOrganisationName(ORG, '   ')
    expect(result.error).toContain('cannot be empty')
    expect(redirects, 'an invalid input should not have reached the auth gate').toEqual([])
  })

  it('sends a signed-out caller to login and writes nothing', async () => {
    role = null
    await expect(updateOrganisationName(ORG, A_NAME)).rejects.toThrow('REDIRECT:/login')
    expect(updates).toEqual([])
  })

  it('sends a non-operator away and writes nothing', async () => {
    // The role is checked on THIS request, not trusted from login. A client who reaches
    // this action must not be able to rename their own organisation.
    role = 'client'
    await expect(updateOrganisationName(ORG, A_NAME)).rejects.toThrow('REDIRECT:/dashboard')
    expect(updates).toEqual([])
  })

  it('returns the database error rather than reporting a write that did not happen', async () => {
    updateError = { message: 'permission denied for table organisations' }
    const result = await updateOrganisationName(ORG, A_NAME)
    expect(result.error).toContain('permission denied')
  })

  it('never writes any column other than name', async () => {
    // The action exists to correct one field. A payload that grew would be a silent
    // widening of what an operator edit can touch.
    await updateOrganisationName(ORG, A_NAME)
    expect(Object.keys(updates[0].payload)).toEqual(['name'])
  })
})
