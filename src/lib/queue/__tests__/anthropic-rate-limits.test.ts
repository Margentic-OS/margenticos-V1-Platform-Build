// The Anthropic header reader.
//
// This module is insurance, not a working constraint: the account measured 10,000
// requests/minute on 2026-08-24 and the queue draws roughly thirty. The tests below
// therefore assert as much about what it does NOT do as about what it does. A governor
// that fires spuriously would slow the queue for no reason and, worse, would suggest to
// a future reader that Anthropic throughput is a real problem here.

import { describe, it, expect } from 'vitest'
import {
  readRateLimitHeaders,
  computeBackoffMs,
  applyRateLimitBackoff,
} from '../anthropic-rate-limits'

const headers = (h: Record<string, string>) => new Headers(h)

describe('readRateLimitHeaders', () => {
  it('reads the full set Anthropic actually returns', () => {
    // These are the real header names and real values measured on 2026-08-24.
    const snapshot = readRateLimitHeaders(headers({
      'anthropic-ratelimit-requests-limit':         '10000',
      'anthropic-ratelimit-requests-remaining':     '9999',
      'anthropic-ratelimit-input-tokens-remaining': '10000000',
      'anthropic-ratelimit-output-tokens-remaining': '2000000',
    }))

    expect(snapshot.requestsLimit).toBe(10000)
    expect(snapshot.requestsRemaining).toBe(9999)
    expect(snapshot.inputTokensRemaining).toBe(10000000)
    expect(snapshot.outputTokensRemaining).toBe(2000000)
    expect(snapshot.retryAfterSeconds).toBeNull()
  })

  it('returns nulls for absent headers rather than zeros', () => {
    // Zero would read as "no headroom left" and pause every call.
    const snapshot = readRateLimitHeaders(headers({}))
    expect(snapshot.requestsRemaining).toBeNull()
    expect(snapshot.requestsLimit).toBeNull()
  })

  it('returns null for an unparseable value', () => {
    const snapshot = readRateLimitHeaders(headers({
      'anthropic-ratelimit-requests-remaining': 'unlimited',
    }))
    expect(snapshot.requestsRemaining).toBeNull()
  })
})

describe('computeBackoffMs — does nothing in the normal case', () => {
  it('returns 0 at the measured live headroom', () => {
    const snapshot = readRateLimitHeaders(headers({
      'anthropic-ratelimit-requests-limit':     '10000',
      'anthropic-ratelimit-requests-remaining': '9999',
    }))
    expect(computeBackoffMs(snapshot)).toBe(0)
  })

  it('returns 0 when no headers are present at all', () => {
    // A missing header is not evidence of pressure. Non-Anthropic paths must not pause.
    expect(computeBackoffMs(readRateLimitHeaders(headers({})))).toBe(0)
  })

  it('returns 0 even at 10% remaining, well below anything this queue can reach', () => {
    const snapshot = readRateLimitHeaders(headers({
      'anthropic-ratelimit-requests-limit':     '10000',
      'anthropic-ratelimit-requests-remaining': '1000',
    }))
    expect(computeBackoffMs(snapshot)).toBe(0)
  })
})

describe('computeBackoffMs — engages only under genuine pressure', () => {
  it('pauses when remaining falls under 5% of the limit', () => {
    const snapshot = readRateLimitHeaders(headers({
      'anthropic-ratelimit-requests-limit':     '10000',
      'anthropic-ratelimit-requests-remaining': '400',
    }))
    expect(computeBackoffMs(snapshot)).toBeGreaterThan(0)
  })

  it('obeys retry-after, which is authoritative', () => {
    const snapshot = readRateLimitHeaders(headers({ 'retry-after': '3' }))
    expect(computeBackoffMs(snapshot)).toBe(3000)
  })

  it('prefers retry-after over the remaining-count rule', () => {
    const snapshot = readRateLimitHeaders(headers({
      'retry-after': '2',
      'anthropic-ratelimit-requests-limit':     '10000',
      'anthropic-ratelimit-requests-remaining': '0',
    }))
    expect(computeBackoffMs(snapshot)).toBe(2000)
  })

  it('caps any single pause so a bad header cannot stall the invocation', () => {
    // A 300s retry-after would otherwise consume the whole function budget.
    const snapshot = readRateLimitHeaders(headers({ 'retry-after': '3600' }))
    expect(computeBackoffMs(snapshot)).toBeLessThanOrEqual(15_000)
  })

  it('ignores a zero or negative retry-after', () => {
    expect(computeBackoffMs(readRateLimitHeaders(headers({ 'retry-after': '0' })))).toBe(0)
  })

  it('does not divide by zero when the limit header is 0', () => {
    const snapshot = readRateLimitHeaders(headers({
      'anthropic-ratelimit-requests-limit':     '0',
      'anthropic-ratelimit-requests-remaining': '0',
    }))
    expect(computeBackoffMs(snapshot)).toBe(0)
  })
})

describe('applyRateLimitBackoff', () => {
  it('returns 0 and does not wait in the normal case', async () => {
    const snapshot = readRateLimitHeaders(headers({
      'anthropic-ratelimit-requests-limit':     '10000',
      'anthropic-ratelimit-requests-remaining': '9999',
    }))
    const started = Date.now()
    expect(await applyRateLimitBackoff(snapshot)).toBe(0)
    expect(Date.now() - started).toBeLessThan(50)
  })

  it('actually waits when a pause is due', async () => {
    const started = Date.now()
    const waited = await applyRateLimitBackoff({
      requestsRemaining: null, requestsLimit: null,
      inputTokensRemaining: null, outputTokensRemaining: null,
      retryAfterSeconds: 0.05,
    })
    expect(waited).toBe(50)
    expect(Date.now() - started).toBeGreaterThanOrEqual(45)
  })
})
