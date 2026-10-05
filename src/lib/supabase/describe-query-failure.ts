// One description of a failed PostgREST request, for every caller that turns one into a
// message.
//
// WHY THIS EXISTS. postgrest-js builds `error.message` from the response BODY. A count sent
// with `head: true` is an HTTP HEAD request, and a HEAD response never has a body, so when
// Supabase's gateway gives up with a 504 the message is the empty string. The queue worker
// threw "countInFlight failed: " with nothing after the colon. Measured 2026-09-11: 14 of the
// 32 events in Sentry MARGENTICOS-15 were that blank message, while the SAME 504 on a POST in
// the same issue read "Gateway Timeout", because a POST response has a body to read.
//
// The status code was on the result the whole time (`status`, `statusText`). Nothing read
// it, because every caller destructured `error` and interpolated `error.message`. So this
// takes the WHOLE result rather than the error, and names the status first.

export interface QueryFailure {
  error: {
    message?: string | null
    code?: string | null
    details?: string | null
  } | null
  status?: number | null
  statusText?: string | null
}

export function describeQueryFailure(result: QueryFailure): string {
  const { error, status, statusText } = result

  let statusPart: string | null = null
  if (typeof status === 'number' && status > 0) {
    statusPart = `HTTP ${status}${statusText ? ` ${statusText}` : ''}`
  } else if (status === 0) {
    // postgrest-js reports a request that never got a response (DNS, reset, abort) as 0.
    statusPart = 'no HTTP response'
  }

  const code = error?.code?.trim() || ''
  const rawMessage = error?.message?.trim() || ''
  const details = error?.details?.trim() || ''

  // A gateway 504 on a request that DOES carry a body arrives as
  // {"message":"Gateway Timeout"}, which only repeats the status text.
  const message = rawMessage && rawMessage !== statusText?.trim() ? rawMessage : ''

  let out = [statusPart, code ? `code ${code}` : null].filter(Boolean).join(', ')
  if (message) out = out ? `${out}: ${message}` : message
  if (details) out = `${out} (details: ${details})`

  if (!rawMessage && !code && !details) {
    return out ? `${out}, with no error body` : 'no status, code or message was returned'
  }
  return out
}
