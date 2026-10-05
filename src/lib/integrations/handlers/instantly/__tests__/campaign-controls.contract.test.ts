// The provider writes behind automatic activation, against the provider's HTTP shapes.
// Each write is read back: a 200 that did not change the campaign must fail, because the
// order that keeps a client under its daily cap rests on writes that actually landed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../auth', () => ({
  getInstantlyApiKey: vi.fn(async () => 'test-key'),
  getInstantlyApiActive: vi.fn(async () => true),
}))

import { createCampaignControls } from '../campaign-controls'

type Held = { status: number; daily_limit: number | null }

/** One campaign on a fake provider. `ignoreWrites` makes every write a 200 that changes nothing. */
function serve(held: Held, opts: { ignoreWrites?: boolean } = {}) {
  const calls: string[] = []
  const fn = vi.fn(async (url: string | URL, init?: { method?: string; body?: unknown }) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${u.replace(/^https?:\/\/[^/]+\/api\/v2/, '')}`)
    if (method === 'PATCH' && !opts.ignoreWrites) Object.assign(held, JSON.parse(String(init?.body)))
    if (method === 'POST' && u.endsWith('/activate') && !opts.ignoreWrites) held.status = 1
    return new Response(JSON.stringify({ id: 'c1', ...held }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fn)
  return calls
}

beforeEach(() => { delete process.env.INSTANTLY_API_BASE_URL })
afterEach(() => vi.unstubAllGlobals())

describe('campaign controls', () => {
  it('reads the daily limit', async () => {
    serve({ status: 1, daily_limit: 90 })
    expect(await createCampaignControls('org').readDailyLimit('c1')).toBe(90)
  })

  it('sets the limit with a PATCH carrying only daily_limit, then reads it back', async () => {
    const calls = serve({ status: 1, daily_limit: 90 })
    await createCampaignControls('org').setDailyLimit('c1', 75)
    expect(calls).toEqual(['PATCH /campaigns/c1', 'GET /campaigns/c1'])
  })

  it('PLANTED: a limit write the provider did not apply throws', async () => {
    serve({ status: 1, daily_limit: 90 }, { ignoreWrites: true })
    await expect(createCampaignControls('org').setDailyLimit('c1', 75)).rejects.toThrow(/read back as 90 after setting 75/)
  })

  it('activates with POST /campaigns/{id}/activate and confirms status 1', async () => {
    const calls = serve({ status: 2, daily_limit: 15 })
    await createCampaignControls('org').activate('c1')
    expect(calls).toEqual(['POST /campaigns/c1/activate', 'GET /campaigns/c1'])
  })

  it('PLANTED: an activation that leaves the campaign paused throws', async () => {
    serve({ status: 2, daily_limit: 15 }, { ignoreWrites: true })
    await expect(createCampaignControls('org').activate('c1')).rejects.toThrow(/status 2 after activating/)
  })

  it('an HTTP error is raised, never read as success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 402 })))
    await expect(createCampaignControls('org').activate('c1')).rejects.toThrow(/HTTP 402/)
  })
})
