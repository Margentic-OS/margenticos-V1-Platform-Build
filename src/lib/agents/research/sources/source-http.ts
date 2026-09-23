// Billing and auth failures from a RESEARCH SOURCE, and why they stop the whole run.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE INCIDENT THIS CLOSES, 2026-09-21
//
// Apify returned HTTP 402 on 50 of 84 prospects in one run. The run completed, wrote 84
// research rows, and reported success. Every one of those 50 prospects was then researched
// from Apollo and web search alone, which between them hold no dated events, so the copy
// that shipped was built on employment history and headcount. Nothing said a source had
// been unavailable, because the only thing recorded was `available: false` with a one-line
// error, which is the same shape a prospect with no LinkedIn profile produces.
//
// This is the SAME INCIDENT as 2026-08-19, one provider along. That one spent the
// Anthropic credit balance three prospects into a six-prospect batch, the fallback
// absorbed it, and the run reported completed 6, failed 0. fatal-api-error.ts was written
// for it and covers Anthropic only, because it is built on the Anthropic SDK's error
// classes. A source that speaks plain HTTP never reaches it.
//
// A BILLING FAILURE IS NOT A PER-PROSPECT CONDITION. It will not clear on the next
// prospect. Every further attempt spends wall clock and writes a row that looks like
// research and is not. So it aborts the run, and it says what the provider actually said.
//
// ─── Why this throws FatalApiError rather than a type of its own ─────────────
//
// There is already one way to say "stop the run" and callers already handle it. A second
// type would mean every abort path needs two catches, and the one that gets forgotten is
// the one that turns this incident back on. One abort type, two producers.
// ═════════════════════════════════════════════════════════════════════════════

import { FatalApiError } from '@/lib/agents/fatal-api-error'

/**
 * The statuses that mean "the account cannot make this call", not "this request failed".
 *
 *   401  token rejected
 *   402  payment required, which is what Apify returned
 *   403  token valid, not entitled to this resource
 *
 * 429 is deliberately absent. A rate limit clears by itself and the callers back off.
 * 5xx is deliberately absent. A provider having a bad minute is a per-request condition.
 */
export const FATAL_SOURCE_STATUSES: ReadonlyArray<number> = [401, 402, 403]

/** How much of a provider's error body is kept. Enough to read, short enough for a log. */
export const ERROR_BODY_CHARS = 2000

/**
 * A source's HTTP call failed, carrying what the provider ACTUALLY SAID.
 *
 * The body is the point. Before this existed, linkedin.ts threw
 * `Apify actor X returned ${response.status}` and dropped the response entirely, so when
 * the 402s were investigated two days later the reason was not merely hard to find, it had
 * never been recorded anywhere and could not be recovered: Apify keeps no run record for a
 * call it refused to start.
 */
export class SourceHttpError extends Error {
  readonly source: string
  readonly status: number
  readonly body: string

  constructor(source: string, status: number, body: string) {
    super(`${source} returned HTTP ${status}: ${body || '(empty body)'}`)
    this.name = 'SourceHttpError'
    this.source = source
    this.status = status
    this.body = body
  }
}

/**
 * Reads a failed response's body without ever throwing.
 *
 * A body read can fail on its own (stream already consumed, socket closed mid-read), and
 * an error while handling an error must not replace the status we already know with a
 * stack trace about reading. Failure to read is recorded as text rather than raised.
 */
export async function readErrorBody(response: { text: () => Promise<string> }): Promise<string> {
  try {
    const text = await response.text()
    return text.slice(0, ERROR_BODY_CHARS)
  } catch (err) {
    return `(response body could not be read: ${String(err)})`
  }
}

/** True when this status means the account cannot call the provider at all. */
export function isFatalSourceStatus(status: number): boolean {
  return FATAL_SOURCE_STATUSES.includes(status)
}

/**
 * Converts a source failure into a run-stopping FatalApiError when it is a billing or auth
 * failure, and returns otherwise so the caller degrades as before.
 *
 * Mirrors throwIfFatal in fatal-api-error.ts deliberately, including the name, so the two
 * read as one mechanism with two entry points.
 */
export function throwIfFatalSource(err: unknown, context: string): void {
  if (err instanceof FatalApiError) throw err
  if (!(err instanceof SourceHttpError)) return
  if (!isFatalSourceStatus(err.status)) return

  throw new FatalApiError(
    `${err.source} returned HTTP ${err.status} (${context}). Provider said: ${err.body || '(empty body)'}`,
    err,
  )
}

/**
 * The one place a source turns a non-ok response into an error.
 *
 * Reads the body FIRST, then throws. Callers that want the degrade-and-continue behaviour
 * catch SourceHttpError; callers that must stop pass it to throwIfFatalSource first.
 */
export async function raiseForStatus(
  source: string,
  response: { ok: boolean; status: number; text: () => Promise<string> },
): Promise<void> {
  if (response.ok) return
  const body = await readErrorBody(response)
  throw new SourceHttpError(source, response.status, body)
}
