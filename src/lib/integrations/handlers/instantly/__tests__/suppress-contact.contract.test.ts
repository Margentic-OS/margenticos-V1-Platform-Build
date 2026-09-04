// Contract tests for the can_suppress_contact handler: the two operations that carry a
// suppression to the sending provider, driven against real HTTP responses.
//
// Two things are under test and they are different in kind:
//
//   findLeadIds  must page to EXHAUSTION and return every match. The lookup it replaces
//                asked for limit 1 and took items[0], so an address held as two leads had
//                one stopped and the rest left sending, silently.
//   stopLead     must READ THE LEAD BACK. A 200 from a write endpoint is the same class of
//                evidence as a notification logged as sent before sending.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('../auth', () => ({
  getInstantlyApiKey: vi.fn(async () => 'test-key'),
  getInstantlyApiActive: vi.fn(async () => true),
}))

import { findLeadIds, stopLead, readLead } from '../suppress-contact'

const ORG = 'org-1'
const ADDRESS = 'person@example.com'

const originalFetch = globalThis.fetch
const originalBaseUrl = process.env.INSTANTLY_API_BASE_URL

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  // A non-production base URL, so the flag gate is satisfied without any chance of a real
  // call escaping if a stub is ever missed.
  process.env.INSTANTLY_API_BASE_URL = 'https://test.invalid/api/v2'
})

afterEach(() => {
  vi.unstubAllGlobals()
  globalThis.fetch = originalFetch
  if (originalBaseUrl === undefined) delete process.env.INSTANTLY_API_BASE_URL
  else process.env.INSTANTLY_API_BASE_URL = originalBaseUrl
})

describe('findLeadIds', () => {
  it('returns EVERY lead for one address across pages, not just the first', async () => {
    // THE REGRESSION TEST FOR THE SINGLE-MATCH LOOKUP.
    const pages = [
      json({ items: [{ id: 'l1', email: ADDRESS }, { id: 'l2', email: ADDRESS }], next_starting_after: 'cur-1' }),
      json({ items: [{ id: 'l3', email: ADDRESS }] }),
    ]
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async () => pages[call++]))

    const result = await findLeadIds(ADDRESS, ORG)

    expect(result).toEqual({ ok: true, leadIds: ['l1', 'l2', 'l3'] })
    expect(call).toBe(2)
  })

  it('sends the cursor back on the second page', async () => {
    const bodies: string[] = []
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body))
      return call++ === 0
        ? json({ items: [{ id: 'l1', email: ADDRESS }], next_starting_after: 'cur-1' })
        : json({ items: [] })
    }))

    await findLeadIds(ADDRESS, ORG)

    expect(JSON.parse(bodies[0]).starting_after).toBeUndefined()
    expect(JSON.parse(bodies[1]).starting_after).toBe('cur-1')
    // distinct_contacts must NOT be sent: it collapses duplicates of one address, which is
    // the opposite of what suppression needs.
    expect(JSON.parse(bodies[0]).distinct_contacts).toBeUndefined()
  })

  it('drops a returned lead whose address is not the one asked for', async () => {
    // The endpoint takes `contacts` as a filter, but a filter honoured on the provider's
    // side is still one this code has not read back. Suppressing the wrong lead is worse
    // than finding none.
    vi.stubGlobal('fetch', vi.fn(async () =>
      json({ items: [{ id: 'l1', email: ADDRESS }, { id: 'l2', email: 'someone@else.com' }] }),
    ))

    expect(await findLeadIds(ADDRESS, ORG)).toEqual({ ok: true, leadIds: ['l1'] })
  })

  it('fails rather than looping when the cursor does not advance', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      json({ items: [{ id: 'l1', email: ADDRESS }], next_starting_after: 'stuck' }),
    ))

    const result = await findLeadIds(ADDRESS, ORG)
    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toContain('did not advance')
  })

  it('reports a provider error as a failure, never as an empty list', async () => {
    // "We could not ask" and "there are none" are different answers.
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 500)))

    const result = await findLeadIds(ADDRESS, ORG)
    expect(result.ok).toBe(false)
  })

  it('deduplicates a lead id that appears on two pages', async () => {
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async () =>
      call++ === 0
        ? json({ items: [{ id: 'l1', email: ADDRESS }], next_starting_after: 'cur-1' })
        : json({ items: [{ id: 'l1', email: ADDRESS }] }),
    ))

    expect(await findLeadIds(ADDRESS, ORG)).toEqual({ ok: true, leadIds: ['l1'] })
  })
})

describe('stopLead', () => {
  it('reads the lead back and confirms our write landed', async () => {
    const calls: Array<{ method: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET' })
      return init?.method === 'PATCH'
        ? json({ id: 'l1' })
        : json({ id: 'l1', status: 3, lt_interest_status: -1 })
    }))

    const result = await stopLead('l1', ORG)

    expect(result.ok).toBe(true)
    expect(calls.map(c => c.method)).toEqual(['PATCH', 'GET'])
  })

  it('FAILS when the write returns 200 but the read-back does not carry it', async () => {
    // The whole reason the read-back exists.
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'PATCH'
        ? json({ id: 'l1' })
        : json({ id: 'l1', status: 1, lt_interest_status: null }),
    ))

    const result = await stopLead('l1', ORG)

    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toContain('read-back disagrees')
  })

  it('FAILS when the write succeeds but the lead cannot be read back at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'PATCH' ? json({ id: 'l1' }) : json({}, 500),
    ))

    const result = await stopLead('l1', ORG)
    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toContain('could not be confirmed')
  })

  it('CONFIRMS while the provider still reports the lead active, because the stop is async', async () => {
    // MEASURED 2026-09-04: the lead carried our write immediately and did not move to
    // Completed for about 43 seconds, reading status 1 throughout. Requiring status to have
    // moved here would fail every suppression this system makes.
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'PATCH'
        ? json({ id: 'l1' })
        : json({ id: 'l1', status: 1, lt_interest_status: -1 }),
    ))

    const result = await stopLead('l1', ORG)
    expect(result.ok).toBe(true)
    expect(result.ok && result.state.status).toBe(1)
  })

  it('does not read back at all when the write itself failed', async () => {
    let gets = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'PATCH') gets++
      return json({ error: 'nope' }, 403)
    }))

    const result = await stopLead('l1', ORG)
    expect(result.ok).toBe(false)
    expect(gets).toBe(0)
  })
})

describe('readLead', () => {
  it('reports a 404 as a failure rather than deciding it means stopped', async () => {
    // A missing lead probably IS a stopped lead, but this function reports what it saw and
    // the caller applies meaning. Deciding here would hide a wrong lead id.
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 404)))

    const result = await readLead('l1', ORG)
    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toContain('404')
  })

  it('reads a missing status as null rather than defaulting it', async () => {
    // isStillSending treats null as still sending. Defaulting to a number here would turn
    // "cannot tell" into a definite answer at the wrong layer.
    vi.stubGlobal('fetch', vi.fn(async () => json({ id: 'l1' })))

    const result = await readLead('l1', ORG)
    expect(result.ok && result.state).toEqual({ leadId: 'l1', status: null, interestStatus: null })
  })
})
