// A send that fails must leave a row behind.
//
// sendTransactionalEmail RETURNS { success: false } rather than throwing, so that a
// notification can never fail the run it is reporting on. That contract is correct and is
// kept. Its cost is that every caller has to remember to check a return value, and on
// 2026-09-05 not one of the twenty-one call sites did: the regenerate route wraps the call
// in try/catch, and a returned value does not enter a catch.
//
// So the failure has to be recorded by the function itself, where no caller can forget.
// These tests are what stop that recording being removed or quietly bypassed.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/email/client', () => ({
  resendClient: { emails: { send: vi.fn() } },
}))

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  flush: vi.fn().mockResolvedValue(true),
}))

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../record-delivery-failure', () => ({
  recordEmailDeliveryFailure: vi.fn().mockResolvedValue(undefined),
}))

import { sendTransactionalEmail } from '../send'
import { resendClient } from '@/lib/email/client'
import { recordEmailDeliveryFailure } from '../record-delivery-failure'

const mockedRecord = vi.mocked(recordEmailDeliveryFailure)
const mockedSend = vi.mocked(resendClient.emails.send)

describe('a failed send is recorded where no caller can forget it', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.RESEND_FROM_EMAIL = 'test@example.com'
  })

  afterEach(() => {
    delete process.env.RESEND_FROM_EMAIL
  })

  it('records a content-validation rejection, with the stage that says it never reached the provider', async () => {
    const result = await sendTransactionalEmail({
      to: 'doug@margenticos.com',
      subject: 'Tone of voice agent failed: MargenticOS',
      html: '<p>Client undefined failed</p>',
    })

    expect(result.success).toBe(false)
    expect(mockedRecord).toHaveBeenCalledTimes(1)
    expect(mockedRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'doug@margenticos.com',
        subject: 'Tone of voice agent failed: MargenticOS',
        stage: 'content_validation',
      }),
    )
  })

  it('records a provider rejection under a different stage, because the remedies differ', async () => {
    ;(mockedSend as never as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: null,
      error: { message: 'Resend is down' },
    })

    const result = await sendTransactionalEmail({
      to: 'doug@margenticos.com',
      subject: 'Clean subject',
      html: '<p>Clean body</p>',
    })

    expect(result.success).toBe(false)
    expect(mockedRecord).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'provider_send', error: 'Resend is down' }),
    )
  })

  it('carries the audience onto the row, so the monitor can say how many were operator alerts', async () => {
    await sendTransactionalEmail({
      to: 'doug@margenticos.com',
      subject: 'Agent failed',
      html: '<p>NaN</p>',
      audience: 'operator',
    })

    expect(mockedRecord).toHaveBeenCalledWith(
      expect.objectContaining({ audience: 'operator' }),
    )
  })

  it('defaults the recorded audience to customer when the caller did not say', async () => {
    await sendTransactionalEmail({
      to: 'someone@client.com',
      subject: 'Clean',
      html: '<p>undefined</p>',
    })

    expect(mockedRecord).toHaveBeenCalledWith(
      expect.objectContaining({ audience: 'customer' }),
    )
  })

  it('records nothing when the send succeeds', async () => {
    ;(mockedSend as never as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: 'msg-123' },
      error: null,
    })

    const result = await sendTransactionalEmail({
      to: 'doug@margenticos.com',
      subject: 'Clean subject',
      html: '<p>Clean body</p>',
      audience: 'operator',
    })

    expect(result.success).toBe(true)
    expect(mockedRecord).not.toHaveBeenCalled()
  })

  it('still returns rather than throwing when the recorder itself fails', async () => {
    // The recorder runs inside the failure path of the notification system. If it can
    // throw, a failed notification becomes a failed request, which is the exact outcome
    // the returned-rather-than-thrown contract exists to prevent.
    //
    // Delete the try/catch in recordFailureQuietly and this test goes red.
    mockedRecord.mockRejectedValueOnce(new Error('database unreachable'))

    const result = await sendTransactionalEmail({
      to: 'doug@margenticos.com',
      subject: 'Agent failed',
      html: '<p>undefined</p>',
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      // The ORIGINAL failure is still what gets reported, not the recorder's failure.
      // A caller that logs result.error needs to see why the email did not send, not why
      // the bookkeeping about it did not save.
      expect(result.error).toContain('undefined')
    }
  })
})
