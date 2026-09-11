// The operator edit path for organisations.booking_url.
//
// WHY THIS FIELD IS WORTH A TEST FILE. It is not a display label. It is read live by
// process-reply.ts and put into the reply a prospect receives after answering positively,
// so a bad value here reaches a real person at the one moment that could become a meeting.
// Until 2026-09-10 the column had no write path outside SQL, and was NULL on both live
// client organisations while the Settings page displayed an invented link.
//
// The tests that matter here are the REFUSALS, and the one about clearing.
//
// No real client name or booking address appears below. The values are neutral on purpose.

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
            // .eq IS HONOURED, and the id is recorded. A fake that swallowed the filter
            // could not tell an update of one organisation from an update of all of them,
            // which is the exact class of hole a fake introduces silently.
            let captured: string | null = null
            const upd = {
              eq(_col: string, val: string) {
                captured = val
                updates.push({ payload, id: captured })
                return Promise.resolve({ error: updateError })
              },
            }
            return upd
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

import { updateBookingUrl } from '../actions'

beforeEach(() => {
  role = 'operator'
  updates = []
  updateError = null
  redirects.length = 0
})

describe('refusals', () => {
  it('refuses a value that is not a URL, and writes nothing', async () => {
    const result = await updateBookingUrl(ORG, 'book a call with me')
    expect(result.error).toMatch(/not a valid web address/i)
    expect(updates).toHaveLength(0)
  })

  it('refuses a bare hostname with no scheme, and writes nothing', async () => {
    // The most likely paste. It must not be silently prefixed: guessing the scheme on a
    // link that gets emailed to a prospect is a guess made in the wrong place.
    const result = await updateBookingUrl(ORG, 'example.test/book/30min')
    expect(result.error).toMatch(/not a valid web address/i)
    expect(updates).toHaveLength(0)
  })

  it('refuses http, because the link is sent to prospects', async () => {
    const result = await updateBookingUrl(ORG, 'http://example.test/book/30min')
    expect(result.error).toMatch(/https/i)
    expect(updates).toHaveLength(0)
  })

  it('refuses a value past the length cap, and writes nothing', async () => {
    const result = await updateBookingUrl(ORG, `https://example.test/${'a'.repeat(600)}`)
    expect(result.error).toMatch(/500 characters or fewer/i)
    expect(updates).toHaveLength(0)
  })
})

describe('accepting a link', () => {
  it('stores an https URL against the organisation it was given', async () => {
    const result = await updateBookingUrl(ORG, 'https://example.test/book/30min')

    expect(result.error).toBeUndefined()
    expect(updates).toHaveLength(1)
    expect(updates[0].payload).toEqual({ booking_url: 'https://example.test/book/30min' })
    // The write is scoped. Without this the fake would accept an unfiltered update.
    expect(updates[0].id).toBe(ORG)
  })

  it('trims surrounding whitespace before storing', async () => {
    await updateBookingUrl(ORG, '  https://example.test/book/30min  ')
    expect(updates[0].payload).toEqual({ booking_url: 'https://example.test/book/30min' })
  })

  it('accepts a booking link from any vendor, not only one', async () => {
    // NOT A STYLE PREFERENCE. Sending prospects to a booking link is tool-agnostic: any
    // link works. Only booking DETECTION depends on the tool (ADR-054). A hostname check
    // here would be Rule Zero and would refuse a client who books through a tool we do
    // not detect, which is the case manual meeting recording exists for.
    const result = await updateBookingUrl(ORG, 'https://some-other-booking-tool.test/u/abc')
    expect(result.error).toBeUndefined()
    expect(updates[0].payload).toEqual({ booking_url: 'https://some-other-booking-tool.test/u/abc' })
  })
})

describe('clearing', () => {
  it('writes NULL rather than an empty string', async () => {
    // An empty string passes a truthiness check in process-reply.ts and would put a blank
    // link into a prospect's reply. NULL is what "no booking link" means everywhere else.
    const result = await updateBookingUrl(ORG, '   ')

    expect(result.error).toBeUndefined()
    expect(updates).toHaveLength(1)
    expect(updates[0].payload).toEqual({ booking_url: null })
    expect(updates[0].payload.booking_url).not.toBe('')
  })
})

describe('authorisation', () => {
  it('redirects an unauthenticated caller and writes nothing', async () => {
    role = null
    await expect(updateBookingUrl(ORG, 'https://example.test/book')).rejects.toThrow('REDIRECT:/login')
    expect(updates).toHaveLength(0)
  })

  it('redirects a client and writes nothing', async () => {
    role = 'client'
    await expect(updateBookingUrl(ORG, 'https://example.test/book')).rejects.toThrow('REDIRECT:/dashboard')
    expect(updates).toHaveLength(0)
  })

  it('checks the role on every call rather than trusting the caller', async () => {
    // The role is read from the database inside the action. A validation-only rejection
    // must not be mistaken for an auth check: this asserts a VALID value is still refused
    // for a client, which is the case a validation-first shortcut would let through.
    role = 'client'
    await expect(updateBookingUrl(ORG, 'https://example.test/book/30min')).rejects.toThrow(/REDIRECT/)
    expect(redirects).toContain('/dashboard')
  })
})

describe('a failed write', () => {
  it('returns the error rather than reporting success', async () => {
    updateError = { message: 'permission denied' }
    const result = await updateBookingUrl(ORG, 'https://example.test/book/30min')
    expect(result.error).toBe('permission denied')
    expect(result.value).toBeUndefined()
  })
})
