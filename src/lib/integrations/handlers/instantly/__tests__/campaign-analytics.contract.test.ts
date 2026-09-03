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

// ── Contacted is people, and only one field carries people ────────────────────
//
// The row below is the live 2026-09-03 response for one real campaign, field for field.
// It is the whole point of this block: contacted_count and new_leads_contacted_count
// both exist, both look like a people count, and only one of them is. Mapping the wrong
// one put 52 on a client's dashboard under the words "prospects contacted" when 24
// people had ever been emailed.
const LIVE_ROW_2026_09_03 = {
  campaign_id: 'camp-live',
  campaign_status: 1,
  leads_count: 24,
  new_leads_contacted_count: 24,
  // Documented as "leads for whom the sequence has started". It is not. 52 > 24 leads.
  contacted_count: 52,
  emails_sent_count: 60,
  reply_count: 2,
  bounced_count: 0,
  unsubscribed_count: 0,
}

describe('fetchCampaignStats — contacted counts people, not emails', () => {
  beforeEach(() => {
    vi.mocked(auth.getInstantlyApiActive).mockResolvedValue(true)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reads people from new_leads_contacted_count, never from contacted_count', async () => {
    makeFetchSpy(200, [LIVE_ROW_2026_09_03])

    const result = await fetchCampaignStats(API_KEY, true, MOCK_BASE_URL)
    const stats = result.get('camp-live')!

    // The assertion that kills a revert. contacted_count is 52 and sitting right there
    // in the response; reading it is the defect.
    expect(stats.contactedCount).toBe(24)
    expect(stats.contactedCount).not.toBe(52)
    expect(stats.leadsCount).toBe(24)
  })

  it('keeps emails and people as separate numbers from separate fields', async () => {
    makeFetchSpy(200, [LIVE_ROW_2026_09_03])

    const stats = (await fetchCampaignStats(API_KEY, true, MOCK_BASE_URL)).get('camp-live')!

    expect(stats.sentCount).toBe(60)
    expect(stats.contactedCount).toBe(24)
    // 60 emails to 24 people. If these are ever equal again, one of them is wrong.
    expect(stats.contactedCount).not.toBe(stats.sentCount)
  })

  it('refuses a contacted count larger than the campaign has leads', async () => {
    // The exact shape the old mapping produced. More people contacted than exist is not
    // a number to render, so the handler hands back null and the caller leaves the
    // stored value alone.
    makeFetchSpy(200, [{
      ...LIVE_ROW_2026_09_03,
      new_leads_contacted_count: 52,
      leads_count: 24,
    }])

    const stats = (await fetchCampaignStats(API_KEY, true, MOCK_BASE_URL)).get('camp-live')!

    expect(stats.contactedCount).toBeNull()
  })

  it('returns null, not zero, when the people field is absent', async () => {
    // Zero would be written to the column and rendered as fact. Null is not written.
    makeFetchSpy(200, [{
      campaign_id: 'camp-live',
      campaign_status: 1,
      emails_sent_count: 60,
      reply_count: 2,
      bounced_count: 0,
    }])

    const stats = (await fetchCampaignStats(API_KEY, true, MOCK_BASE_URL)).get('camp-live')!

    expect(stats.contactedCount).toBeNull()
    expect(stats.sentCount).toBe(60)
  })

  it('allows contacted to equal leads, which is a fully contacted campaign', async () => {
    makeFetchSpy(200, [{ ...LIVE_ROW_2026_09_03, new_leads_contacted_count: 24, leads_count: 24 }])

    const stats = (await fetchCampaignStats(API_KEY, true, MOCK_BASE_URL)).get('camp-live')!

    expect(stats.contactedCount).toBe(24)
  })
})
