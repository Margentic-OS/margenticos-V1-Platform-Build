// The operator switch for the revenue band as a sourcing filter.
//
// WHY THIS IS WORTH A TEST FILE. Switching it on removes, at the client's next ICP approval,
// every company the sourcing provider holds no revenue figure for: measured at 78% of one live
// client's search on 2026-09-10. It must only ever be switched by an operator, and a value
// that is not a real boolean must never be read as "on".
//
// The tests that matter are the REFUSALS. No real client name appears below.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const ORG = 'org-under-test'

let role: string | null = 'operator'
let updates: Array<{ payload: Record<string, unknown>; id: string | null }> = []
let updateError: { message: string } | null = null
const redirects: string[] = []

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    redirects.push(to)
    throw new Error(`REDIRECT:${to}`)
  },
}))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

// after() runs its callback at once, so the test can see work the action defers past the
// response. Outside a request it would throw, which is the other reason it is mocked.
vi.mock('next/server', async (importOriginal) => {
  // Partial, never whole: a whole-module mock silently drops every other export.
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, after: (fn: () => unknown) => fn() }
})

// ADR-061. The switch is a targeting field, so flipping it runs the settings comparison.
// What that comparison does is tested in propose-icp-filter-spec.test.ts. What is pinned
// here is that the action calls it, for the right organisation, and only after a write
// that succeeded.
const proposeForOrganisation = vi.hoisted(() => vi.fn())
vi.mock('@/lib/sourcing/propose-icp-filter-spec', () => ({
  proposeIcpFilterSpecForOrganisationSafely: proposeForOrganisation,
}))

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
            // .eq IS HONOURED and the id recorded, so an update of one organisation cannot be
            // mistaken for an update of all of them.
            return {
              eq(_col: string, val: string) {
                updates.push({ payload, id: val })
                return Promise.resolve({ error: updateError })
              },
            }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => makeSessionClient()),
}))

import { updateRevenueFilterEnabled } from '../actions'

beforeEach(() => {
  role = 'operator'
  updates = []
  updateError = null
  redirects.length = 0
  proposeForOrganisation.mockReset()
  proposeForOrganisation.mockResolvedValue({ outcome: 'unchanged' })
})

describe('an operator can switch it, for one organisation only', () => {
  it('switches it on', async () => {
    const result = await updateRevenueFilterEnabled(ORG, true)
    expect(result).toEqual({ value: true })
    expect(updates).toEqual([{ payload: { sourcing_revenue_filter_enabled: true }, id: ORG }])
  })

  it('switches it off', async () => {
    const result = await updateRevenueFilterEnabled(ORG, false)
    expect(result).toEqual({ value: false })
    expect(updates).toEqual([{ payload: { sourcing_revenue_filter_enabled: false }, id: ORG }])
  })

  it('reports a database refusal rather than claiming success', async () => {
    updateError = { message: 'placeholder database refusal' }
    const result = await updateRevenueFilterEnabled(ORG, true)
    expect(result.error).toBe('placeholder database refusal')
    expect(result.value).toBeUndefined()
  })
})

describe('the refusals', () => {
  it('a client cannot switch it: redirected, and nothing is written', async () => {
    role = 'client'
    await expect(updateRevenueFilterEnabled(ORG, true)).rejects.toThrow('REDIRECT:/dashboard')
    expect(updates).toEqual([])
  })

  it('a signed-out caller cannot switch it', async () => {
    role = null
    await expect(updateRevenueFilterEnabled(ORG, true)).rejects.toThrow('REDIRECT:/login')
    expect(updates).toEqual([])
  })

  it('the string "false" is refused, never read as on', async () => {
    const result = await updateRevenueFilterEnabled(ORG, 'false' as unknown as boolean)
    expect(result.error).toMatch(/on or off/)
    expect(updates).toEqual([])
  })
})

describe('flipping it files a proposal, and never changes the search by itself (ADR-061)', () => {
  it('runs the settings comparison for THAT organisation after a successful write', async () => {
    await updateRevenueFilterEnabled(ORG, true)
    expect(proposeForOrganisation.mock.calls).toEqual([[ORG]])
  })

  it('does not run it when the write was refused: the switch did not move', async () => {
    updateError = { message: 'placeholder database refusal' }
    await updateRevenueFilterEnabled(ORG, true)
    expect(proposeForOrganisation).not.toHaveBeenCalled()
  })

  it('does not run it for a caller who was turned away', async () => {
    role = 'client'
    await expect(updateRevenueFilterEnabled(ORG, true)).rejects.toThrow('REDIRECT:/dashboard')
    role = null
    await expect(updateRevenueFilterEnabled(ORG, true)).rejects.toThrow('REDIRECT:/login')
    await updateRevenueFilterEnabled(ORG, 'false' as unknown as boolean)
    expect(proposeForOrganisation).not.toHaveBeenCalled()
  })
})
