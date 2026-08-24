// Deciding whether a failure should be retried or should stop.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS IS ITS OWN MODULE AND WHY IT DEFAULTS THE WAY IT DOES
//
// Getting this wrong is expensive in BOTH directions, which is why it is deterministic
// code with an explicit list rather than a judgement made at each call site:
//
//   treating permanent as transient  -> a malformed request retries three times and
//                                       pays three times to reach the same answer
//   treating transient as permanent  -> a momentary 429 discards work that would have
//                                       succeeded a minute later
//
// THE DEFAULT IS 'transient'. An error we do not recognise is more likely to be a
// network blip or a provider hiccup than a permanent contract violation, and the
// attempt cap bounds the cost of being wrong: an unrecognised permanent error retries
// at most max_attempts times and then terminates anyway. The reverse default has no
// such bound, because a genuinely transient error marked permanent is simply lost.
//
// ACCOUNT-LEVEL EXHAUSTION IS NOT A JOB-LEVEL FAILURE. A depleted Apify balance or an
// exhausted Apollo credit pool is not something the next job can succeed at either.
// Retrying 3,333 jobs against a dry account is the "never loop on a paid API" failure
// happening at scale rather than per job. Those errors are classified permanent AND
// reported separately via isAccountExhaustion, which the worker uses to trip the
// circuit breaker and turn the job type's flag off.

import type { ErrorClass } from './types'

/**
 * HTTP statuses that mean "try again later".
 *
 *   408 Request Timeout        the request did not complete, nothing was decided
 *   409 Conflict               concurrent modification, may resolve on retry
 *   425 Too Early              replay protection, retryable by definition
 *   429 Too Many Requests      rate limited. The canonical transient failure
 *   500 Internal Server Error  provider fault
 *   502 Bad Gateway            provider fault
 *   503 Service Unavailable    provider fault
 *   504 Gateway Timeout        provider fault
 *   529 Overloaded             Anthropic's explicit "capacity, come back" status
 */
export const TRANSIENT_HTTP_STATUSES = [408, 409, 425, 429, 500, 502, 503, 504, 529] as const

/**
 * HTTP statuses that mean "this will fail identically forever".
 *
 *   400 Bad Request            our request is malformed. Retrying sends the same bytes
 *   401 Unauthorized           the key is wrong. It will still be wrong in 30 seconds
 *   403 Forbidden              not permitted, or plan-gated. Apollo returns this on the
 *                              free tier for bulk_match
 *   404 Not Found              the target does not exist
 *   405 Method Not Allowed     wiring error on our side
 *   413 Payload Too Large      the payload will be the same size on retry
 *   422 Unprocessable Entity   semantically invalid input
 *
 * 402 Payment Required is deliberately NOT here. It is handled as account exhaustion
 * below, which is permanent AND trips the circuit breaker.
 */
export const PERMANENT_HTTP_STATUSES = [400, 401, 403, 404, 405, 413, 422] as const

/**
 * Anthropic error `type` values. The SDK surfaces these on APIError instances and they
 * are more reliable than the status alone.
 */
const TRANSIENT_ANTHROPIC_TYPES = ['overloaded_error', 'api_error', 'rate_limit_error']
const PERMANENT_ANTHROPIC_TYPES = [
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'not_found_error',
]

/** Node and undici network failures. All transient: nothing reached the provider. */
const TRANSIENT_NETWORK_CODES = [
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH',
  'ENETUNREACH', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
]

/**
 * Phrases that mean the ACCOUNT has run out, not that this job failed.
 *
 * Matched case-insensitively against the message. Deliberately narrow, and it must stay
 * that way: a false positive here does not fail one job, it trips the circuit breaker
 * and turns the whole job type off for every client.
 *
 * Two words are specifically NOT here, and both were considered:
 *   'credit'   appears in ordinary Apollo success payloads as credits_consumed
 *   'billing'  matches any message mentioning it, including a parse error naming a
 *              billing_address field or a stack trace through a billing module
 *
 * Only phrases that cannot plausibly appear in an ordinary error qualify.
 */
const ACCOUNT_EXHAUSTION_PATTERNS = [
  'insufficient credit',
  'insufficient credits',
  'credit balance is too low',
  'out of credits',
  'quota exceeded',
  'monthly usage limit',
  'usage limit exceeded',
  'payment required',
  'plan limit',
  // 'billing' ON ITS OWN WAS REMOVED on 2026-08-24. It is a bare substring that matches
  // any message merely mentioning the word: a parse error naming a billing_address
  // field, a 404 for a /billing endpoint, a stack trace through a module with billing in
  // its path. The blast radius of a false positive here is not one job. isAccountExhaustion
  // trips the circuit breaker, which turns a whole job type off for EVERY client, so one
  // unlucky error string would stop all enrichment or all research platform-wide until a
  // human noticed and flipped the flag back.
  // These two phrases carry the same signal with none of the ambiguity.
  'billing issue',
  'billing problem',
]

interface ErrorShape {
  status?: number
  statusCode?: number
  code?: string
  type?: string
  message?: string
  error?: { type?: string; message?: string }
  cause?: unknown
}

/** Best-effort extraction of an HTTP status from the many shapes providers throw. */
export function extractStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null
  const e = err as ErrorShape
  const direct = e.status ?? e.statusCode
  if (typeof direct === 'number') return direct

  // Handlers in this repo throw plain Errors carrying the status in the message, e.g.
  // `Apollo API returned 403: ...` and `Apify actor X returned 500`. Those messages are
  // the only signal available, so they are parsed rather than ignored.
  if (typeof e.message === 'string') {
    const m = e.message.match(/\b(?:returned|status|HTTP)\s+(\d{3})\b/i)
    if (m) return Number(m[1])
  }
  return null
}

function messageOf(err: unknown): string {
  if (typeof err === 'string') return err
  if (typeof err !== 'object' || err === null) return ''
  const e = err as ErrorShape
  return `${e.message ?? ''} ${e.error?.message ?? ''}`.trim()
}

/**
 * Does this error mean the ACCOUNT is out of money or quota, rather than this one job
 * having failed?
 *
 * The worker uses this to trip the circuit breaker. Nothing else should retry on it.
 */
export function isAccountExhaustion(err: unknown): boolean {
  const status = extractStatus(err)
  if (status === 402) return true

  const message = messageOf(err).toLowerCase()
  if (!message) return false
  return ACCOUNT_EXHAUSTION_PATTERNS.some(p => message.includes(p))
}

/**
 * Transient or permanent.
 *
 * Order matters. Account exhaustion is checked first because a 402 or a "quota
 * exceeded" message must never be read as a retryable rate limit. Explicit provider
 * error types are checked before raw statuses because Anthropic returns 400 for
 * several distinguishable conditions. Everything unrecognised falls through to
 * transient, bounded by the attempt cap.
 */
export function classifyError(err: unknown): ErrorClass {
  if (isAccountExhaustion(err)) return 'permanent'

  if (typeof err === 'object' && err !== null) {
    const e = err as ErrorShape
    const providerType = e.type ?? e.error?.type
    if (providerType) {
      if (PERMANENT_ANTHROPIC_TYPES.includes(providerType)) return 'permanent'
      if (TRANSIENT_ANTHROPIC_TYPES.includes(providerType)) return 'transient'
    }
    if (typeof e.code === 'string' && TRANSIENT_NETWORK_CODES.includes(e.code)) {
      return 'transient'
    }
  }

  const status = extractStatus(err)
  if (status !== null) {
    if ((PERMANENT_HTTP_STATUSES as readonly number[]).includes(status)) return 'permanent'
    if ((TRANSIENT_HTTP_STATUSES as readonly number[]).includes(status)) return 'transient'
    // Any other 4xx is a client error and will not fix itself.
    if (status >= 400 && status < 500) return 'permanent'
    if (status >= 500) return 'transient'
  }

  // `fetch failed` with no status: the request never reached the provider.
  const message = messageOf(err).toLowerCase()
  if (message.includes('fetch failed') || message.includes('network')) return 'transient'

  return 'transient'
}

/** One-line description safe to store in job_queue.last_error. Truncated for the column. */
export function describeError(err: unknown, maxLength = 900): string {
  const status = extractStatus(err)
  const base = messageOf(err) || (typeof err === 'string' ? err : 'Unknown error')
  const prefixed = status !== null && !base.includes(String(status))
    ? `HTTP ${status}: ${base}`
    : base
  return prefixed.length > maxLength ? `${prefixed.slice(0, maxLength - 3)}...` : prefixed
}
