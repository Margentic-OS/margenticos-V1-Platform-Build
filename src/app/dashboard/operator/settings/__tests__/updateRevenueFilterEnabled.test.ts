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
