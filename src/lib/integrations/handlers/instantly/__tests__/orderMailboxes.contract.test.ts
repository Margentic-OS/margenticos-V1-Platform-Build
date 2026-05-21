// Contract test for orderMailboxes() — verifies request shape, response parsing,
// TLD validation, feature flag guard, and per-status error handling.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { orderMailboxes } from '../orderMailboxes'
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

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}))

const ORG_ID = 'org-test-123'
const MOCK_BASE_URL = 'https://developer.instantly.ai/_mock/api/v2'
const TEST_DOMAINS = ['client-email.com']

const SIMULATE_SUCCESS: Record<string, unknown> = {
  order_placed: false,
  order_is_valid: true,
  total_price: 73.00,
}

const REAL_ORDER_SUCCESS: Record<string, unknown> = {
  order_placed: true,
  order_is_valid: true,
  total_price: 73.00,
}

function makeFetchSpy(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.spyOn(global, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    })
  )
}

describe('orderMailboxes — TLD validation', () => {
  it('rejects .io domain before any API call', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
    await expect(
      orderMailboxes(ORG_ID, ['client-email.io'], true)
    ).rejects.toThrow(InstantlyValidationError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects .co.uk domain before any API call', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
    await expect(
      orderMailboxes(ORG_ID, ['client-email.co.uk'], true)
    ).rejects.toThrow(InstantlyValidationError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects mixed valid/invalid domains before any API call', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
    await expect(
      orderMailboxes(ORG_ID, ['good.com', 'bad.net'], true)
    ).rejects.toThrow(InstantlyValidationError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('accepts .com domain', async () => {
    process.env.INSTANTLY_API_BASE_URL = MOCK_BASE_URL
    makeFetchSpy(200, SIMULATE_SUCCESS)
    await expect(orderMailboxes(ORG_ID, ['client-email.com'], true)).resolves.toBeDefined()
    delete process.env.INSTANTLY_API_BASE_URL
    vi.restoreAllMocks()
  })

  it('accepts .org domain', async () => {
    process.env.INSTANTLY_API_BASE_URL = MOCK_BASE_URL
    makeFetchSpy(200, SIMULATE_SUCCESS)
    await expect(orderMailboxes(ORG_ID, ['client-email.org'], true)).resolves.toBeDefined()
    delete process.env.INSTANTLY_API_BASE_URL
    vi.restoreAllMocks()
  })
})

describe('orderMailboxes — request shape', () => {
  beforeEach(() => {
    process.env.INSTANTLY_API_BASE_URL = MOCK_BASE_URL
  })

  afterEach(() => {
    delete process.env.INSTANTLY_API_BASE_URL
    vi.restoreAllMocks()
  })

  it('posts to /dfy-email-account-orders', async () => {
    const fetchSpy = makeFetchSpy(200, SIMULATE_SUCCESS)
    await orderMailboxes(ORG_ID, TEST_DOMAINS, true)
    const [url] = fetchSpy.mock.calls[0]
    expect(String(url)).toBe(`${MOCK_BASE_URL}/dfy-email-account-orders`)
  })

  it('sends Authorization Bearer header', async () => {
    const fetchSpy = makeFetchSpy(200, SIMULATE_SUCCESS)
    await orderMailboxes(ORG_ID, TEST_DOMAINS, true)
    const [, options] = fetchSpy.mock.calls[0]
    const headers = options?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer test-api-key')
  })

  it('sends order_type=dfy in body', async () => {
    const fetchSpy = makeFetchSpy(200, SIMULATE_SUCCESS)
    await orderMailboxes(ORG_ID, TEST_DOMAINS, true)
    const [, options] = fetchSpy.mock.calls[0]
    const body = JSON.parse(options?.body as string)
    expect(body.order_type).toBe('dfy')
  })

  it('sends simulate=true for quote call', async () => {
    const fetchSpy = makeFetchSpy(200, SIMULATE_SUCCESS)
    await orderMailboxes(ORG_ID, TEST_DOMAINS, true)
    const [, options] = fetchSpy.mock.calls[0]
    const body = JSON.parse(options?.body as string)
    expect(body.simulate).toBe(true)
  })

  it('sends simulate=false for real order call', async () => {
    vi.mocked(auth.getInstantlyApiActive).mockResolvedValue(true)
    const fetchSpy = makeFetchSpy(200, REAL_ORDER_SUCCESS)
    await orderMailboxes(ORG_ID, TEST_DOMAINS, false)
    const [, options] = fetchSpy.mock.calls[0]
    const body = JSON.parse(options?.body as string)
    expect(body.simulate).toBe(false)
  })

  it('sends items array with domain objects', async () => {
    const fetchSpy = makeFetchSpy(200, SIMULATE_SUCCESS)
    await orderMailboxes(ORG_ID, ['a.com', 'b.org'], true)
    const [, options] = fetchSpy.mock.calls[0]
    const body = JSON.parse(options?.body as string)
    expect(body.items).toEqual([{ domain: 'a.com' }, { domain: 'b.org' }])
  })
})

describe('orderMailboxes — response parsing', () => {
  beforeEach(() => {
    process.env.INSTANTLY_API_BASE_URL = MOCK_BASE_URL
  })

  afterEach(() => {
    delete process.env.INSTANTLY_API_BASE_URL
    vi.restoreAllMocks()
  })

  it('returns correct DfyOrderResult shape for simulate=true', async () => {
    makeFetchSpy(200, SIMULATE_SUCCESS)
    const result = await orderMailboxes(ORG_ID, TEST_DOMAINS, true)
    expect(result).toEqual({
      order_placed: false,
      order_is_valid: true,
      total_price: 73.00,
      simulated: true,
    })
  })

  it('returns correct DfyOrderResult shape for simulate=false', async () => {
    makeFetchSpy(200, REAL_ORDER_SUCCESS)
    const result = await orderMailboxes(ORG_ID, TEST_DOMAINS, false)
    expect(result).toEqual({
      order_placed: true,
      order_is_valid: true,
      total_price: 73.00,
      simulated: false,
    })
  })

  it('falls back to price field when total_price is absent', async () => {
    makeFetchSpy(200, { order_placed: false, order_is_valid: true, price: 58.50 })
    const result = await orderMailboxes(ORG_ID, TEST_DOMAINS, true)
    expect(result.total_price).toBe(58.50)
  })

  it('returns null total_price when neither price field is present', async () => {
    makeFetchSpy(200, { order_placed: false, order_is_valid: false })
    const result = await orderMailboxes(ORG_ID, TEST_DOMAINS, true)
    expect(result.total_price).toBeNull()
  })
})

describe('orderMailboxes — feature flag guard', () => {
  afterEach(() => {
    delete process.env.INSTANTLY_API_BASE_URL
    vi.restoreAllMocks()
  })

  it('throws InstantlyFlagError for real order when flag=false and URL is production', async () => {
    vi.mocked(auth.getInstantlyApiActive).mockResolvedValue(false)
    process.env.INSTANTLY_API_BASE_URL = 'https://api.instantly.ai/api/v2'

    await expect(
      orderMailboxes(ORG_ID, TEST_DOMAINS, false)
    ).rejects.toThrow(InstantlyFlagError)
  })

  it('allows simulate=true even when flag=false and URL is production', async () => {
    vi.mocked(auth.getInstantlyApiActive).mockResolvedValue(false)
    process.env.INSTANTLY_API_BASE_URL = 'https://api.instantly.ai/api/v2'

    makeFetchSpy(200, SIMULATE_SUCCESS)
    await expect(
      orderMailboxes(ORG_ID, TEST_DOMAINS, true)
    ).resolves.toBeDefined()
  })

  it('allows real order when flag=true and URL is production', async () => {
    vi.mocked(auth.getInstantlyApiActive).mockResolvedValue(true)
    process.env.INSTANTLY_API_BASE_URL = 'https://api.instantly.ai/api/v2'

    makeFetchSpy(200, REAL_ORDER_SUCCESS)
    await expect(
      orderMailboxes(ORG_ID, TEST_DOMAINS, false)
    ).resolves.toBeDefined()
  })
})

describe('orderMailboxes — error handling', () => {
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
      orderMailboxes(ORG_ID, TEST_DOMAINS, true)
    ).rejects.toThrow(InstantlyNetworkError)
  })

  it('throws InstantlyRateLimitError on 429', async () => {
    makeFetchSpy(429, { error: 'rate_limited' })
    await expect(
      orderMailboxes(ORG_ID, TEST_DOMAINS, true)
    ).rejects.toThrow(InstantlyRateLimitError)
  })

  it('throws InstantlyValidationError on 400', async () => {
    makeFetchSpy(400, { error: 'bad_request' })
    await expect(
      orderMailboxes(ORG_ID, TEST_DOMAINS, true)
    ).rejects.toThrow(InstantlyValidationError)
  })

  it('throws InstantlyValidationError on 422', async () => {
    makeFetchSpy(422, { error: 'unprocessable' })
    await expect(
      orderMailboxes(ORG_ID, TEST_DOMAINS, true)
    ).rejects.toThrow(InstantlyValidationError)
  })

  it('throws InstantlyServerError on 500', async () => {
    makeFetchSpy(500, { error: 'internal_server_error' })
    await expect(
      orderMailboxes(ORG_ID, TEST_DOMAINS, true)
    ).rejects.toThrow(InstantlyServerError)
  })

  it('throws InstantlyApiError on unexpected 401', async () => {
    makeFetchSpy(401, { error: 'unauthorized' })
    await expect(
      orderMailboxes(ORG_ID, TEST_DOMAINS, true)
    ).rejects.toThrow(InstantlyApiError)
  })

  it('throws InstantlyApiError when response is not valid JSON', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('not-json', { status: 200 })
    )
    await expect(
      orderMailboxes(ORG_ID, TEST_DOMAINS, true)
    ).rejects.toThrow(InstantlyApiError)
  })
})
