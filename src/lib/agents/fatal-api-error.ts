// Distinguishes API failures that mean "stop the run" from failures worth degrading past.
//
// WHY THIS EXISTS
// On 2026-08-19 the Anthropic credit balance ran out three prospects into a six-prospect
// batch. Seven "credit balance is too low" errors fired. synthesizeResearch caught them,
// returned the ICP-proxy fallback, and the batch reported completed 6, failed 0. A
// billing failure was indistinguishable from a prospect that genuinely had no signal, so
// two prospects silently lost verified 6/6 observations and the run looked clean.
//
// A missing credit balance is not a per-prospect condition. It will not resolve on the
// next prospect, and every further attempt spends nothing but wall clock while writing
// wrong data. It has to abort the run and say why.
//
// Deliberately narrow. Rate limits are NOT fatal: callWithRetry already backs off and
// they clear on their own. Connection blips, 500s and model refusals stay non-fatal too,
// because those really are per-request and the fallback path is the right answer.

import {
  APIError,
  AuthenticationError,
  PermissionDeniedError,
  BadRequestError,
} from '@anthropic-ai/sdk'

/** Thrown when the run cannot continue. Callers must not swallow this. */
export class FatalApiError extends Error {
  readonly reason: string
  constructor(reason: string, cause: unknown) {
    super(`Fatal API error, run aborted: ${reason}. Original: ${String(cause)}`)
    this.name = 'FatalApiError'
    this.reason = reason
  }
}

// Substrings that mark a spent balance rather than a malformed request. The Anthropic
// billing failure arrives as a 400 invalid_request_error, which is otherwise the same
// status a bad prompt would produce, so the message is the only discriminator.
const BILLING_MARKERS = [
  'credit balance is too low',
  'insufficient credit',
  'insufficient_quota',
  'billing',
  'payment required',
]

/**
 * Returns a human reason when the error means the whole run should stop, or null when
 * the caller should degrade as before.
 */
export function fatalApiReason(err: unknown): string | null {
  if (err instanceof FatalApiError) return err.reason
  if (err instanceof AuthenticationError) return 'API key rejected (401)'
  if (err instanceof PermissionDeniedError) return 'API key lacks permission for this model (403)'

  // Read the message AND the raw error body. The SDK builds `message` by serialising the
  // response body, so the billing text usually lands there, but reading `error` directly
  // means a body shape change cannot silently blind the check.
  const raw = err as { message?: unknown; error?: unknown }
  const message = [
    String(raw?.message ?? ''),
    (() => { try { return JSON.stringify(raw?.error ?? '') } catch { return '' } })(),
    String(err ?? ''),
  ].join(' ').toLowerCase()

  if (err instanceof BadRequestError && BILLING_MARKERS.some(m => message.includes(m))) {
    return 'Anthropic credit balance exhausted'
  }
  // 402 has no dedicated SDK class.
  if (err instanceof APIError && err.status === 402) return 'Payment required (402)'
  // Last resort for errors that reach us already stringified through a wrapper.
  if (BILLING_MARKERS.some(m => message.includes(m))) return 'Anthropic credit balance exhausted'

  return null
}

/** Rethrows as FatalApiError when the failure is unrecoverable. Otherwise returns. */
export function throwIfFatal(err: unknown, context: string): void {
  const reason = fatalApiReason(err)
  if (reason) throw new FatalApiError(`${reason} (${context})`, err)
}
