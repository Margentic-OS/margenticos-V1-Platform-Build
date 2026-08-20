// Guards the failure mode from 2026-08-19: the Anthropic credit balance ran out three
// prospects into a six-prospect batch, seven "credit balance is too low" errors fired,
// synthesizeResearch caught them and returned the ICP proxy, and the batch reported
// completed 6 / failed 0. A billing failure was indistinguishable from a clean run.

import { describe, it, expect } from 'vitest'
import { AuthenticationError, PermissionDeniedError, BadRequestError, RateLimitError, InternalServerError } from '@anthropic-ai/sdk'
import { fatalApiReason, throwIfFatal, FatalApiError } from '../fatal-api-error'

// The SDK builds `message` by serialising the response BODY and discards the string
// passed as the message argument, so the billing text has to go in the body to reproduce
// what production actually threw.
const bad = (detail: string) =>
  new BadRequestError(
    400,
    { type: 'error', error: { type: 'invalid_request_error', message: detail } },
    'ignored by the SDK',
    new Headers(),
  )

describe('fatal failures that must abort the run', () => {
  it('catches the exact credit-balance message that fired in production', () => {
    const err = bad('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}')
    expect(fatalApiReason(err)).toBe('Anthropic credit balance exhausted')
  })

  it('catches a rejected API key', () => {
    const err = new AuthenticationError(401, { type: 'error' }, 'invalid x-api-key', new Headers())
    expect(fatalApiReason(err)).toBe('API key rejected (401)')
  })

  it('catches a permission failure', () => {
    const err = new PermissionDeniedError(403, { type: 'error' }, 'forbidden', new Headers())
    expect(fatalApiReason(err)).toContain('permission')
  })

  it('catches a billing failure that reached us already stringified', () => {
    expect(fatalApiReason(new Error('Error: 400 credit balance is too low'))).toBe('Anthropic credit balance exhausted')
  })

  it('throwIfFatal throws a FatalApiError carrying the context', () => {
    const err = bad('your credit balance is too low')
    expect(() => throwIfFatal(err, 'synthesis for prospect abc')).toThrow(FatalApiError)
    try { throwIfFatal(err, 'synthesis for prospect abc') } catch (e) {
      expect((e as FatalApiError).reason).toContain('synthesis for prospect abc')
    }
  })
})

describe('failures that must NOT abort the run', () => {
  it('does not treat a rate limit as fatal, since callWithRetry backs off', () => {
    const err = new RateLimitError(429, { type: 'error' }, 'rate limit', new Headers())
    expect(fatalApiReason(err)).toBeNull()
  })

  it('does not treat a 500 as fatal', () => {
    const err = new InternalServerError(500, { type: 'error' }, 'overloaded', new Headers())
    expect(fatalApiReason(err)).toBeNull()
  })

  it('does not treat an ordinary malformed request as fatal', () => {
    // Same 400 status as the billing failure. Only the message separates them.
    expect(fatalApiReason(bad('max_tokens must be greater than 0'))).toBeNull()
  })

  it('does not treat a connection blip as fatal', () => {
    expect(fatalApiReason(new Error('socket hang up'))).toBeNull()
  })

  it('throwIfFatal is a no-op for non-fatal errors', () => {
    expect(() => throwIfFatal(new Error('socket hang up'), 'ctx')).not.toThrow()
  })
})
