// Contract tests for reply-actions — verifies suppressLead and sendThreadReply
// request shapes, response parsing, feature flag guard, and error handling.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { suppressLead, sendThreadReply } from '../reply-actions'
import { InstantlyFlagError } from '../types'

const API_KEY = 'test-api-key'
const MOCK_BASE_URL = 'https://developer.instantly.ai/_mock/api/v2'
const LEAD_ID = 'lead-123'
const REPLY_UUID = 'email-456'

function makeFetchSpy(status: number, body: unknown) {
  return vi.spyOn(global, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  )
}

describe('suppressLead — feature flag guard', () => {
  beforeEach(() => {
    process.env.INSTANTLY_API_BASE_URL = 'https://api.instantly.ai/api/v2'
  })

  afterEach(() => {
    delete process.env.INSTANTLY_API_BASE_URL
    vi.restoreAllMocks()
  })

  it('throws InstantlyFlagError when flag is false and URL is production', async () => {
    await expect(
      suppressLead(LEAD_ID, API_KEY, 'https://api.instantly.ai/api/v2', false)
    ).rejects.toThrow(InstantlyFlagError)
  })

  it('proceeds when flag is false and URL is mock (not production)', async () => {
    delete process.env.INSTANTLY_API_BASE_URL
    makeFetchSpy(200, { success: true })
    const result = await suppressLead(LEAD_ID, API_KEY, MOCK_BASE_URL, false)
    expect(result.ok).toBe(true)
  })
})

describe('suppressLead — request shape', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sends PATCH request to /leads/{id}', async () => {
    const fetchSpy = makeFetchSpy(200, { success: true })
    await suppressLead(LEAD_ID, API_KEY, MOCK_BASE_URL, true)
    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url, options] = fetchSpy.mock.calls[0]
    expect(String(url)).toBe(`${MOCK_BASE_URL}/leads/${LEAD_ID}`)
    expect(options?.method).toBe('PATCH')
  })

  it('sends lt_interest_status=-1 in body', async () => {
    const fetchSpy = makeFetchSpy(200, { success: true })
    await suppressLead(LEAD_ID, API_KEY, MOCK_BASE_URL, true)
    const [, options] = fetchSpy.mock.calls[0]
    const body = JSON.parse(options?.body as string)
    expect(body.lt_interest_status).toBe(-1)
  })
})

describe('sendThreadReply — feature flag guard', () => {
  beforeEach(() => {
    process.env.INSTANTLY_API_BASE_URL = 'https://api.instantly.ai/api/v2'
  })

  afterEach(() => {
    delete process.env.INSTANTLY_API_BASE_URL
    vi.restoreAllMocks()
  })

  it('throws InstantlyFlagError when flag is false and URL is production', async () => {
    await expect(
      sendThreadReply(
        { replyToUuid: REPLY_UUID, eaccount: 'test@example.com', subject: 'Re: Hello', bodyText: 'Thanks', bodyHtml: '<p>Thanks</p>' },
        API_KEY,
        'https://api.instantly.ai/api/v2',
        false
      )
    ).rejects.toThrow(InstantlyFlagError)
  })

  it('proceeds when flag is false and URL is mock (not production)', async () => {
    delete process.env.INSTANTLY_API_BASE_URL
    makeFetchSpy(200, { id: 'msg-789' })
    const result = await sendThreadReply(
      { replyToUuid: REPLY_UUID, eaccount: 'test@example.com', subject: 'Re: Hello', bodyText: 'Thanks', bodyHtml: '<p>Thanks</p>' },
      API_KEY,
      MOCK_BASE_URL,
      false
    )
    expect(result.ok).toBe(true)
  })
})

describe('sendThreadReply — request shape', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sends POST request to /emails/reply', async () => {
    const fetchSpy = makeFetchSpy(200, { id: 'msg-789' })
    await sendThreadReply(
      { replyToUuid: REPLY_UUID, eaccount: 'test@example.com', subject: 'Re: Hello', bodyText: 'Thanks', bodyHtml: '<p>Thanks</p>' },
      API_KEY,
      MOCK_BASE_URL,
      true
    )
    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url, options] = fetchSpy.mock.calls[0]
    expect(String(url)).toBe(`${MOCK_BASE_URL}/emails/reply`)
    expect(options?.method).toBe('POST')
  })

  it('sends reply_to_uuid, eaccount, subject, and body in request', async () => {
    const fetchSpy = makeFetchSpy(200, { id: 'msg-789' })
    await sendThreadReply(
      { replyToUuid: REPLY_UUID, eaccount: 'test@example.com', subject: 'Re: Hello', bodyText: 'Thanks', bodyHtml: '<p>Thanks</p>' },
      API_KEY,
      MOCK_BASE_URL,
      true
    )
    const [, options] = fetchSpy.mock.calls[0]
    const body = JSON.parse(options?.body as string)
    expect(body.reply_to_uuid).toBe(REPLY_UUID)
    expect(body.eaccount).toBe('test@example.com')
    expect(body.subject).toBe('Re: Hello')
    expect(body.body.text).toBe('Thanks')
  })
})
