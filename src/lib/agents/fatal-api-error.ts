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
// It happened again on 2026-09-24, with a different message: an account-level USAGE CAP
// rather than an empty balance. See USAGE_CAP_MARKERS below. Two causes, one shape.
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

// ─── A USAGE CAP IS NOT A SPENT BALANCE, AND THE FIX IS DIFFERENT ────────────
//
// THE 2026-09-24 RECURRENCE. 81 prospects were dispatched and refused one at a time,
// each having paid for part of its source fetch first, because the message below matches
// nothing in BILLING_MARKERS. Mean time to failure was 22.4s against 250s for a completed
// run, so every one of them had started fetching before the refusal landed. This is the
// 2026-08-19 failure exactly, in wording the marker list did not cover.
//
//   400 invalid_request_error
//   "You have reached your specified API usage limits.
//    You will regain access on 2026-10-01 at 00:00 UTC."
//
// SEPARATE FROM BILLING_MARKERS ON PURPOSE, because the two need different actions from
// the operator and the reason string is what they read. A spent balance needs money. This
// needs the monthly cap raised in the Anthropic Console: the account has funds and has hit
// a ceiling the account holder set. Folding it into 'credit balance exhausted' would send
// someone to top up a balance that is not the problem.
//
// THE MARKER IS THE PHRASE, NOT THE WORDS 'usage limit'. A per-minute rate limit also
// talks about limits being exceeded, and rate limits are deliberately non-fatal because
// callWithRetry backs off and they clear on their own. 'specified api usage limit' cannot
// plausibly appear in one. The date is excluded because it moves every month.
const USAGE_CAP_MARKERS = [
  'specified api usage limit',
]

/** What the operator has to do about it, in the string they will actually see. */
const USAGE_CAP_REASON =
  'Anthropic API usage limit reached (a self-imposed monthly cap, not a spent balance: raise it in the Anthropic Console)'

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

  // Checked BEFORE the billing markers so the more specific reason wins. 'billing' is a
  // bare substring in that list and a future Anthropic message could carry both.
  if (USAGE_CAP_MARKERS.some(m => message.includes(m))) return USAGE_CAP_REASON

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
