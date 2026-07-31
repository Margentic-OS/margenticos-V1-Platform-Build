// Contract test for validateCampaign() — verifies request shape, response parsing,
// feature flag guard, and error handling.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { validateCampaign } from '../validateCampaign'
import * as auth from '../auth'

vi.mock('../auth', () => ({
  getInstantlyApiKey: vi.fn().mockResolvedValue('test-api-key'),
  getInstantlyApiActive: vi.fn().mockResolvedValue(true),
}))

const ORG_ID = 'org-test-123'
const CAMPAIGN_UUID = 'campaign-uuid-456'
const MOCK_BASE_URL = 'https://developer.instantly.ai/_mock/api/v2'

const CAMPAIGN_RESPONSE = {
  id: CAMPAIGN_UUID,
  name: 'Test Campaign',
  status: 'active',
  scheduling_status: 'sent',
}

function makeFetchSpy(status: number, body: unknown) {
  return vi.spyOn(global, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  )
}

describe('validateCampaign — request shape', () => {
  beforeEach(() => {
    process.env.INSTANTLY_API_BASE_URL = MOCK_BASE_URL
  })

  afterEach(() => {
    delete process.env.INSTANTLY_API_BASE_URL
    vi.restoreAllMocks()
  })

  it('sends GET request to /campaigns/{uuid}', async () => {
    const fetchSpy = makeFetchSpy(200, CAMPAIGN_RESPONSE)
    await validateCampaign(ORG_ID, CAMPAIGN_UUID)
    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url, options] = fetchSpy.mock.calls[0]
    expect(String(url)).toBe(`${MOCK_BASE_URL}/campaigns/${CAMPAIGN_UUID}`)
    expect(options?.method ?? 'GET').toBe('GET')
  })

  it('sends Authorization Bearer header', async () => {
    const fetchSpy = makeFetchSpy(200, CAMPAIGN_RESPONSE)
    await validateCampaign(ORG_ID, CAMPAIGN_UUID)
    const [, options] = fetchSpy.mock.calls[0]
    const headers = options?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer test-api-key')
  })
})

describe('validateCampaign — response parsing', () => {
  beforeEach(() => {
    process.env.INSTANTLY_API_BASE_URL = MOCK_BASE_URL
  })

  afterEach(() => {
    delete process.env.INSTANTLY_API_BASE_URL
    vi.restoreAllMocks()
  })

  it('returns CampaignValidationResult with name, status, schedulingStatus', async () => {
    makeFetchSpy(200, CAMPAIGN_RESPONSE)
    const result = await validateCampaign(ORG_ID, CAMPAIGN_UUID)
    expect(result.name).toBe('Test Campaign')
    expect(result.status).toBe('active')
    expect(result.schedulingStatus).toBe('sent')
  })

  it('handles missing schedulingStatus', async () => {
    const responseWithoutScheduling = { ...CAMPAIGN_RESPONSE, scheduling_status: undefined }
    makeFetchSpy(200, responseWithoutScheduling)
    const result = await validateCampaign(ORG_ID, CAMPAIGN_UUID)
    expect(result.schedulingStatus).toBeNull()
  })
})

describe('validateCampaign — feature flag guard', () => {
  afterEach(() => {
    delete process.env.INSTANTLY_API_BASE_URL
    vi.restoreAllMocks()
  })

  it('throws InstantlyFlagError when flag is false and URL is production', async () => {
    vi.mocked(auth.getInstantlyApiActive).mockResolvedValue(false)
    process.env.INSTANTLY_API_BASE_URL = 'https://api.instantly.ai/api/v2'

    await expect(
      validateCampaign(ORG_ID, CAMPAIGN_UUID)
    ).rejects.toThrow()
  })

  it('proceeds when flag is false and URL is mock (not production)', async () => {
    vi.mocked(auth.getInstantlyApiActive).mockResolvedValue(false)
    process.env.INSTANTLY_API_BASE_URL = undefined

    makeFetchSpy(200, CAMPAIGN_RESPONSE)
    const result = await validateCampaign(ORG_ID, CAMPAIGN_UUID)
    expect(result.name).toBe('Test Campaign')
  })
})
