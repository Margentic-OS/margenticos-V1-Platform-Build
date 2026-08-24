// Reading Anthropic's rate-limit headers and slowing down if they ever get tight.
//
// ═════════════════════════════════════════════════════════════════════════════
// THIS IS INSURANCE. IT IS NOT LOAD-BEARING. READ THIS BEFORE RELYING ON IT.
//
// Measured live on this account on 2026-08-24, from response headers on a real call,
// identical for claude-haiku-4-5-20251001, claude-opus-4-6 and claude-sonnet-4-6:
//
//     anthropic-ratelimit-requests-limit        10000     per minute
//     anthropic-ratelimit-input-tokens-limit    10000000  per minute
//     anthropic-ratelimit-output-tokens-limit   2000000   per minute
//
// That is roughly 166 requests per second. Prospect research makes about three
// Anthropic calls per prospect and composition makes one, so at the queue's ceiling of
// ten concurrent research prospects the platform draws on the order of THIRTY requests
// per minute against a limit of TEN THOUSAND.
//
// Anthropic is therefore nowhere near the binding constraint, and nothing in this file
// will engage under normal operation. The real ceiling is Apify: 25 concurrent actor
// runs and a monthly spend cap. That is governed by a concurrency limit in config.ts,
// which is the correct instrument for a limit expressed in simultaneous runs and
// dollars. A request-rate governor would control neither.
//
// So why does this exist at all? Because the account tier is not a constant. If it is
// ever downgraded, or a workload is moved to a key with different limits, the failure
// mode without this file is a wave of 429s discovered by being refused. Reading a
// header we are already receiving costs nothing and turns that into a slowdown.
//
// DO NOT size worker concurrency off this module, and do not let a future reader infer
// from its existence that Anthropic throughput is a problem worth designing around on
// this account. If that ever changes, re-measure and update the numbers above.

import { logger } from '@/lib/logger'

export interface RateLimitSnapshot {
  requestsRemaining:    number | null
  requestsLimit:        number | null
  inputTokensRemaining: number | null
  outputTokensRemaining: number | null
  /** Seconds to wait, from a 429's retry-after header. */
  retryAfterSeconds:    number | null
}

/**
 * Below this fraction of the stated limit we start pausing.
 *
 * 5% rather than something larger because these limits reset every minute: dropping
 * below 5% of 10,000 requests means 9,500 calls in under sixty seconds, which this
 * platform cannot produce. A higher threshold would make the governor fire on ordinary
 * traffic and slow the queue for no reason.
 */
const LOW_REMAINING_FRACTION = 0.05

/** Cap on any single self-imposed pause, so a bad header cannot stall a whole invocation. */
const MAX_BACKOFF_MS = 15_000

function readNumber(headers: Headers, name: string): number | null {
  const raw = headers.get(name)
  if (raw === null) return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

/** Pull the rate-limit picture out of any Anthropic response. */
export function readRateLimitHeaders(headers: Headers): RateLimitSnapshot {
  return {
    requestsRemaining:     readNumber(headers, 'anthropic-ratelimit-requests-remaining'),
    requestsLimit:         readNumber(headers, 'anthropic-ratelimit-requests-limit'),
    inputTokensRemaining:  readNumber(headers, 'anthropic-ratelimit-input-tokens-remaining'),
    outputTokensRemaining: readNumber(headers, 'anthropic-ratelimit-output-tokens-remaining'),
    retryAfterSeconds:     readNumber(headers, 'retry-after'),
  }
}

/**
 * How long to wait before the next Anthropic call, in milliseconds.
 *
 * Returns 0 in the overwhelmingly common case. Non-zero means either the provider told
 * us to wait (retry-after, which is authoritative and always obeyed) or a remaining
 * count has fallen under the threshold.
 *
 * Absent headers return 0. A missing header is not evidence of pressure, and treating
 * it as such would make every non-Anthropic code path pause for no reason.
 */
export function computeBackoffMs(snapshot: RateLimitSnapshot): number {
  if (snapshot.retryAfterSeconds !== null && snapshot.retryAfterSeconds > 0) {
    return Math.min(snapshot.retryAfterSeconds * 1000, MAX_BACKOFF_MS)
  }

  const { requestsRemaining, requestsLimit } = snapshot
  if (requestsRemaining !== null && requestsLimit !== null && requestsLimit > 0) {
    if (requestsRemaining / requestsLimit < LOW_REMAINING_FRACTION) {
      logger.warn('anthropic-rate-limits: request headroom is low, pausing before the next call', {
        requests_remaining: requestsRemaining,
        requests_limit:     requestsLimit,
        note:
          'This should not happen on the measured tier (10,000 rpm). If it does, the ' +
          'account limits have changed and src/lib/queue/config.ts needs re-measuring.',
      })
      return MAX_BACKOFF_MS
    }
  }

  // Token budgets are checked only against their own remaining values, because the
  // limit headers describe a per-minute bucket that refills continuously. A low
  // absolute figure with no limit to compare against is not actionable.
  return 0
}

/** Await the pause computed above. Returns the milliseconds actually waited. */
export async function applyRateLimitBackoff(snapshot: RateLimitSnapshot): Promise<number> {
  const ms = computeBackoffMs(snapshot)
  if (ms > 0) await new Promise(resolve => setTimeout(resolve, ms))
  return ms
}
