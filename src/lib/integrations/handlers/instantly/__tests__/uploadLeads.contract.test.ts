// Contract test for uploadLeads() — verifies request shape, response parsing,
// feature flag refusal, and per-status error handling.
//
// Uses vi.spyOn(global, 'fetch') because the Instantly mock server at
// developer.instantly.ai/_mock/api/v2 returns HTML (Next.js docs page),
// not JSON. Spying achieves the same wire-protocol verification without
// requiring a live server.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { uploadLeads } from '../uploadLeads'
import {
  InstantlyFlagError,
  InstantlyNetworkError,
  InstantlyRateLimitError,
  InstantlyValidationError,
  InstantlyServerError,
  InstantlyApiError,
} from '../types'
import * as auth from '../auth'

vi.mock('../auth', () => ({
  getInstantlyApiKey: vi.fn().mockResolvedValue('test-api-key'),
  getInstantlyApiActive: vi.fn().mockResolvedValue(true),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => ({
      update: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => Promise.resolve({ error: null })),
        })),
      })),
    })),
  })),
}))

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}))

const ORG_ID = 'org-test-123'
const CAMPAIGN_ID = 'campaign-test-456'
const MOCK_BASE_URL = 'https://developer.instantly.ai/_mock/api/v2'

const MINIMAL_LEAD = { email: 'test@example.com' }

const SUCCESS_RESPONSE = {
  status: 'ok',
  leads_uploaded: 1,
  created_leads: [{ id: 'lead-id-1', email: 'test@example.com' }],
  in_blocklist: 0,
  duplicated_leads: 0,
  invalid_email_count: 0,
  incomplete_count: 0,
}

function makeFetchSpy(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.spyOn(global, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    })
  )
}

describe('uploadLeads — request shape', () => {
  beforeEach(() => {
    process.env.INSTANTLY_API_BASE_URL = MOCK_BASE_URL
  })

  afterEach(() => {
    delete process.env.INSTANTLY_API_BASE_URL
    vi.restoreAllMocks()
  })

  it('posts to /leads/add with correct URL', async () => {
    const fetchSpy = makeFetchSpy(200, SUCCESS_RESPONSE)
    await uploadLeads(ORG_ID, CAMPAIGN_ID, [MINIMAL_LEAD])
    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url] = fetchSpy.mock.calls[0]
    expect(String(url)).toBe(`${MOCK_BASE_URL}/leads/add`)
  })

  it('sends Authorization Bearer header', async () => {
    const fetchSpy = makeFetchSpy(200, SUCCESS_RESPONSE)
    await uploadLeads(ORG_ID, CAMPAIGN_ID, [MINIMAL_LEAD])
    const [, options] = fetchSpy.mock.calls[0]
    const headers = options?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer test-api-key')
  })

  it('sends Content-Type application/json', async () => {
    const fetchSpy = makeFetchSpy(200, SUCCESS_RESPONSE)
    await uploadLeads(ORG_ID, CAMPAIGN_ID, [MINIMAL_LEAD])
    const [, options] = fetchSpy.mock.calls[0]
    const headers = options?.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('sends campaign_id (not campaign) in request body', async () => {
    const fetchSpy = makeFetchSpy(200, SUCCESS_RESPONSE)
    await uploadLeads(ORG_ID, CAMPAIGN_ID, [MINIMAL_LEAD])
    const [, options] = fetchSpy.mock.calls[0]
    const body = JSON.parse(options?.body as string)
    expect(body.campaign_id).toBe(CAMPAIGN_ID)
    expect(body.campaign).toBeUndefined()
  })

  it('sends skip_if_in_workspace and skip_if_in_campaign flags', async () => {
    const fetchSpy = makeFetchSpy(200, SUCCESS_RESPONSE)
    await uploadLeads(ORG_ID, CAMPAIGN_ID, [MINIMAL_LEAD])
    const [, options] = fetchSpy.mock.calls[0]
    const body = JSON.parse(options?.body as string)
    expect(body.skip_if_in_workspace).toBe(true)
    expect(body.skip_if_in_campaign).toBe(true)
  })

  it('includes optional lead fields when provided', async () => {
    const fetchSpy = makeFetchSpy(200, SUCCESS_RESPONSE)
    const lead = {
      email: 'test@example.com',
      first_name: 'Alice',
      last_name: 'Smith',
      company_name: 'Acme',
      job_title: 'Founder',
      personalization: 'Great podcast ep.',
      custom_variables: { custom_intro: 'Hi' },
    }
    await uploadLeads(ORG_ID, CAMPAIGN_ID, [lead])
    const [, options] = fetchSpy.mock.calls[0]
    const body = JSON.parse(options?.body as string)
    const sent = body.leads[0]
    expect(sent.email).toBe(lead.email)
    expect(sent.first_name).toBe(lead.first_name)
    expect(sent.last_name).toBe(lead.last_name)
    expect(sent.company_name).toBe(lead.company_name)
    expect(sent.job_title).toBe(lead.job_title)
    expect(sent.personalization).toBe(lead.personalization)
    expect(sent.custom_intro).toBe('Hi')
  })

  it('omits optional fields when not provided', async () => {
    const fetchSpy = makeFetchSpy(200, SUCCESS_RESPONSE)
    await uploadLeads(ORG_ID, CAMPAIGN_ID, [MINIMAL_LEAD])
    const [, options] = fetchSpy.mock.calls[0]
    const body = JSON.parse(options?.body as string)
    const sent = body.leads[0]
    expect(sent.first_name).toBeUndefined()
    expect(sent.personalization).toBeUndefined()
  })
})

describe('uploadLeads — response parsing', () => {
  beforeEach(() => {
    process.env.INSTANTLY_API_BASE_URL = MOCK_BASE_URL
  })

  afterEach(() => {
    delete process.env.INSTANTLY_API_BASE_URL
    vi.restoreAllMocks()
  })

  it('returns the expected LeadUploadResult shape', async () => {
    makeFetchSpy(200, SUCCESS_RESPONSE)
    const result = await uploadLeads(ORG_ID, CAMPAIGN_ID, [MINIMAL_LEAD])
    expect(result).toEqual({
      leads_uploaded: 1,
      created_count: 1,
      in_blocklist: 0,
      duplicated: 0,
      invalid_email_count: 0,
      incomplete_count: 0,
    })
  })

  it('handles multi-lead response with partial creation', async () => {
    const response = {
      ...SUCCESS_RESPONSE,
      leads_uploaded: 2,
      created_leads: [{ id: 'lead-1', email: 'a@example.com' }],
      duplicated_leads: 1,
    }
    makeFetchSpy(200, response)
    const result = await uploadLeads(ORG_ID, CAMPAIGN_ID, [
      { email: 'a@example.com' },
      { email: 'b@example.com' },
    ])
    expect(result.created_count).toBe(1)
    expect(result.duplicated).toBe(1)
  })
})

describe('uploadLeads — feature flag refusal', () => {
  afterEach(() => {
    delete process.env.INSTANTLY_API_BASE_URL
    vi.restoreAllMocks()
  })

  it('throws InstantlyFlagError when flag is false and URL is production', async () => {
    vi.mocked(auth.getInstantlyApiActive).mockResolvedValue(false)
    process.env.INSTANTLY_API_BASE_URL = 'https://api.instantly.ai/api/v2'

    await expect(
      uploadLeads(ORG_ID, CAMPAIGN_ID, [MINIMAL_LEAD])
    ).rejects.toThrow(InstantlyFlagError)
  })

  it('does NOT throw InstantlyFlagError when flag is false and URL is mock', async () => {
    vi.mocked(auth.getInstantlyApiActive).mockResolvedValue(false)
    process.env.INSTANTLY_API_BASE_URL = MOCK_BASE_URL

    makeFetchSpy(200, SUCCESS_RESPONSE)
    await expect(
      uploadLeads(ORG_ID, CAMPAIGN_ID, [MINIMAL_LEAD])
    ).resolves.toBeDefined()
  })

  it('does NOT throw InstantlyFlagError when flag is true and URL is production', async () => {
    vi.mocked(auth.getInstantlyApiActive).mockResolvedValue(true)
    process.env.INSTANTLY_API_BASE_URL = 'https://api.instantly.ai/api/v2'

    makeFetchSpy(200, SUCCESS_RESPONSE)
    await expect(
      uploadLeads(ORG_ID, CAMPAIGN_ID, [MINIMAL_LEAD])
    ).resolves.toBeDefined()
  })
})

describe('uploadLeads — error handling', () => {
  beforeEach(() => {
    process.env.INSTANTLY_API_BASE_URL = MOCK_BASE_URL
    vi.mocked(auth.getInstantlyApiActive).mockResolvedValue(true)
  })

  afterEach(() => {
    delete process.env.INSTANTLY_API_BASE_URL
    vi.restoreAllMocks()
  })

  it('throws InstantlyNetworkError when fetch rejects', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(
      uploadLeads(ORG_ID, CAMPAIGN_ID, [MINIMAL_LEAD])
    ).rejects.toThrow(InstantlyNetworkError)
  })

  it('throws InstantlyRateLimitError on 429', async () => {
    makeFetchSpy(429, { error: 'rate_limited' })
    await expect(
      uploadLeads(ORG_ID, CAMPAIGN_ID, [MINIMAL_LEAD])
    ).rejects.toThrow(InstantlyRateLimitError)
  })

  it('throws InstantlyValidationError on 400', async () => {
    makeFetchSpy(400, { error: 'bad_request', message: 'Missing required field' })
    await expect(
      uploadLeads(ORG_ID, CAMPAIGN_ID, [MINIMAL_LEAD])
    ).rejects.toThrow(InstantlyValidationError)
  })

  it('throws InstantlyValidationError on 422', async () => {
    makeFetchSpy(422, { error: 'unprocessable', message: 'Invalid email format' })
    await expect(
      uploadLeads(ORG_ID, CAMPAIGN_ID, [MINIMAL_LEAD])
    ).rejects.toThrow(InstantlyValidationError)
  })

  it('throws InstantlyServerError on 500', async () => {
    makeFetchSpy(500, { error: 'internal_server_error' })
    await expect(
      uploadLeads(ORG_ID, CAMPAIGN_ID, [MINIMAL_LEAD])
    ).rejects.toThrow(InstantlyServerError)
  })

  it('throws InstantlyServerError on 503', async () => {
    makeFetchSpy(503, { error: 'service_unavailable' })
    await expect(
      uploadLeads(ORG_ID, CAMPAIGN_ID, [MINIMAL_LEAD])
    ).rejects.toThrow(InstantlyServerError)
  })

  it('throws InstantlyApiError on unexpected 401', async () => {
    makeFetchSpy(401, { error: 'unauthorized' })
    await expect(
      uploadLeads(ORG_ID, CAMPAIGN_ID, [MINIMAL_LEAD])
    ).rejects.toThrow(InstantlyApiError)
  })

  it('throws InstantlyApiError when response is not valid JSON', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('not-json', { status: 200 })
    )
    await expect(
      uploadLeads(ORG_ID, CAMPAIGN_ID, [MINIMAL_LEAD])
    ).rejects.toThrow(InstantlyApiError)
  })
})
