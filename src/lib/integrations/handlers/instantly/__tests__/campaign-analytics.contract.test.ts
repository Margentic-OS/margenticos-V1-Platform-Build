// Contract test for fetchCampaignStats() — verifies request shape, response parsing,
// feature flag guard, and error handling.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchCampaignStats } from '../campaign-analytics'
import * as auth from '../auth'

vi.mock('../auth', () => ({
  getInstantlyApiActive: vi.fn().mockResolvedValue(true),
}))

const API_KEY = 'test-api-key'
const MOCK_BASE_URL = 'https://developer.instantly.ai/_mock/api/v2'

const SAMPLE_ANALYTICS = [
  {
    campaign_id: 'camp-1',
    emails_sent_count: 100,
    reply_count: 5,
    bounced_count: 2,
  },
  {
    campaign_id: 'camp-2',
    emails_sent_count: 50,
    reply_count: 3,
    bounced_count: 1,
  },
]

function makeFetchSpy(status: number, body: unknown) {
  return vi.spyOn(global, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  )
}

describe('fetchCampaignStats — request shape', () => {
  beforeEach(() => {
    process.env.INSTANTLY_API_BASE_URL = MOCK_BASE_URL
  })

  afterEach(() => {
    delete process.env.INSTANTLY_API_BASE_URL
    vi.restoreAllMocks()
  })

  it('sends GET request to /campaigns/analytics', async () => {
    const fetchSpy = makeFetchSpy(200, SAMPLE_ANALYTICS)
    await fetchCampaignStats(API_KEY, true, `${MOCK_BASE_URL}`)
    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url, options] = fetchSpy.mock.calls[0]
    expect(String(url)).toBe(`${MOCK_BASE_URL}/campaigns/analytics`)
    expect(options?.method ?? 'GET').toBe('GET')
  })

  it('sends Authorization Bearer header', async () => {
    const fetchSpy = makeFetchSpy(200, SAMPLE_ANALYTICS)
    await fetchCampaignStats(API_KEY, true, `${MOCK_BASE_URL}`)
    const [, options] = fetchSpy.mock.calls[0]
    const headers = options?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer test-api-key')
  })
})

describe('fetchCampaignStats — response parsing', () => {
  beforeEach(() => {
    process.env.INSTANTLY_API_BASE_URL = MOCK_BASE_URL
  })

  afterEach(() => {
    delete process.env.INSTANTLY_API_BASE_URL
    vi.restoreAllMocks()
  })

  it('maps campaign_id to key in result Map', async () => {
    makeFetchSpy(200, SAMPLE_ANALYTICS)
    const result = await fetchCampaignStats(API_KEY, true, `${MOCK_BASE_URL}`)
    expect(result.has('camp-1')).toBe(true)
    expect(result.has('camp-2')).toBe(true)
  })

  it('maps Instantly field names to capability names', async () => {
    makeFetchSpy(200, SAMPLE_ANALYTICS)
    const result = await fetchCampaignStats(API_KEY, true, `${MOCK_BASE_URL}`)
    const camp1 = result.get('camp-1')
    expect(camp1?.sentCount).toBe(100)
    expect(camp1?.repliedCount).toBe(5)
    expect(camp1?.bouncedCount).toBe(2)
  })
})

describe('fetchCampaignStats — feature flag guard', () => {
  afterEach(() => {
    delete process.env.INSTANTLY_API_BASE_URL
    vi.restoreAllMocks()
  })

  it('throws InstantlyFlagError when flag is false and URL is production', async () => {
    process.env.INSTANTLY_API_BASE_URL = 'https://api.instantly.ai/api/v2'

    await expect(
      fetchCampaignStats(API_KEY, false, 'https://api.instantly.ai/api/v2')
    ).rejects.toThrow()
  })

  it('proceeds when flag is false and URL is mock (not production)', async () => {
    process.env.INSTANTLY_API_BASE_URL = undefined
    makeFetchSpy(200, SAMPLE_ANALYTICS)

    const result = await fetchCampaignStats(API_KEY, false, MOCK_BASE_URL)
    expect(result.size).toBe(2)
  })
})
