// Which failures we retry and which we stop on.
//
// Getting this wrong costs money in one direction and loses work in the other, so every
// status in the two published lists is asserted rather than sampled.

import { describe, it, expect } from 'vitest'
import {
  classifyError,
  describeError,
  extractStatus,
  isAccountExhaustion,
  PERMANENT_HTTP_STATUSES,
  TRANSIENT_HTTP_STATUSES,
} from '../error-classification'

const withStatus = (status: number, message = 'boom') =>
  Object.assign(new Error(message), { status })

describe('classifyError — HTTP statuses', () => {
  it.each(TRANSIENT_HTTP_STATUSES)('treats %i as transient', status => {
    expect(classifyError(withStatus(status))).toBe('transient')
  })

  it.each(PERMANENT_HTTP_STATUSES)('treats %i as permanent', status => {
    expect(classifyError(withStatus(status))).toBe('permanent')
  })

  it('treats 429 as transient — the canonical back-off case', () => {
    expect(classifyError(withStatus(429, 'Too Many Requests'))).toBe('transient')
  })

  it('treats 400 as permanent — the same bytes will fail identically', () => {
    expect(classifyError(withStatus(400, 'Bad Request'))).toBe('permanent')
  })

  it('treats 529 as transient — Anthropic overload', () => {
    expect(classifyError(withStatus(529, 'Overloaded'))).toBe('transient')
  })

  it('treats an unlisted 4xx as permanent', () => {
    expect(classifyError(withStatus(418))).toBe('permanent')
  })

  it('treats an unlisted 5xx as transient', () => {
    expect(classifyError(withStatus(507))).toBe('transient')
  })

  it('reads statusCode as well as status', () => {
    expect(classifyError({ statusCode: 429, message: 'rate limited' })).toBe('transient')
  })
})

describe('classifyError — provider error types beat raw statuses', () => {
  it('treats an Anthropic overloaded_error as transient', () => {
    expect(classifyError({ type: 'overloaded_error', message: 'Overloaded' })).toBe('transient')
  })

  it('treats an Anthropic invalid_request_error as permanent', () => {
    expect(classifyError({ type: 'invalid_request_error', message: 'bad params' })).toBe('permanent')
  })

  it('treats an authentication_error as permanent — the key will still be wrong later', () => {
    expect(classifyError({ error: { type: 'authentication_error' }, message: 'bad key' }))
      .toBe('permanent')
  })

  it('prefers the provider type over a status that would say otherwise', () => {
    // Anthropic returns 400 for several distinguishable conditions, so the type wins.
    const err = { status: 400, type: 'overloaded_error', message: 'Overloaded' }
    expect(classifyError(err)).toBe('transient')
  })
})

describe('classifyError — network failures never reached the provider', () => {
  it.each(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'])(
    'treats %s as transient',
    code => {
      expect(classifyError(Object.assign(new Error('socket'), { code }))).toBe('transient')
    },
  )

  it('treats a bare "fetch failed" as transient', () => {
    expect(classifyError(new Error('fetch failed'))).toBe('transient')
  })
})

describe('classifyError — the default', () => {
  it('defaults an unrecognised error to transient, bounded by the attempt cap', () => {
    expect(classifyError(new Error('something nobody has seen before'))).toBe('transient')
  })

  it('handles a thrown string', () => {
    expect(classifyError('just a string')).toBe('transient')
  })

  it('handles null and undefined without throwing', () => {
    expect(classifyError(null)).toBe('transient')
    expect(classifyError(undefined)).toBe('transient')
  })
})

describe('isAccountExhaustion — the circuit breaker trigger', () => {
  it('detects a 402', () => {
    expect(isAccountExhaustion(withStatus(402, 'Payment Required'))).toBe(true)
  })

  it('detects an Anthropic low-balance message', () => {
    expect(isAccountExhaustion(new Error('Your credit balance is too low'))).toBe(true)
  })

  it('detects a monthly usage limit', () => {
    expect(isAccountExhaustion(new Error('Monthly usage limit reached for this account'))).toBe(true)
  })

  it('does NOT fire on the word credits appearing in an ordinary reply', () => {
    // Apollo's normal success payload contains credits_consumed. A false positive here
    // would turn a whole job type off, so the patterns are deliberately narrow.
    expect(isAccountExhaustion(new Error('parse error near credits_consumed: 4'))).toBe(false)
  })

  it('does not fire on a plain 429', () => {
    expect(isAccountExhaustion(withStatus(429, 'Too Many Requests'))).toBe(false)
  })

  it('classifies exhaustion as permanent, never as a retryable rate limit', () => {
    expect(classifyError(withStatus(402, 'Payment Required'))).toBe('permanent')
    expect(classifyError(new Error('quota exceeded'))).toBe('permanent')
  })
})

describe('extractStatus — parsing the shapes this repo actually throws', () => {
  it('reads a status property', () => {
    expect(extractStatus({ status: 503 })).toBe(503)
  })

  it('parses the Apollo handler message format', () => {
    // src/lib/sourcing/handlers/adapter-apollo-enrichment.ts throws exactly this shape.
    expect(extractStatus(new Error('Apollo API returned 403: plan-gated'))).toBe(403)
  })

  it('parses the Apify source message format', () => {
    // src/lib/agents/research/sources/linkedin.ts throws exactly this shape.
    expect(extractStatus(new Error('Apify actor abc/def returned 500'))).toBe(500)
  })

  it('returns null when there is no status to find', () => {
    expect(extractStatus(new Error('no numbers here'))).toBeNull()
  })

  it('does not mistake an arbitrary three-digit number for a status', () => {
    expect(extractStatus(new Error('processed 429 prospects'))).toBeNull()
  })
})

describe('describeError — what gets stored in last_error', () => {
  it('prefixes the status when the message does not already carry it', () => {
    expect(describeError(withStatus(503, 'Service Unavailable'))).toBe('HTTP 503: Service Unavailable')
  })

  it('does not double up when the message already names the status', () => {
    expect(describeError(new Error('Apollo API returned 403: plan-gated')))
      .toBe('Apollo API returned 403: plan-gated')
  })

  it('truncates to fit the column', () => {
    const long = describeError(new Error('x'.repeat(5000)))
    expect(long.length).toBeLessThanOrEqual(900)
    expect(long.endsWith('...')).toBe(true)
  })

  it('never returns an empty string', () => {
    expect(describeError({}).length).toBeGreaterThan(0)
  })
})
