// A ceiling on how long a Supabase call may hang.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
//
// Nothing in this codebase bounded a Supabase call. No AbortSignal, no maxDuration on
// any dashboard route, no timeout of any kind. A read that opened a connection and never
// answered had exactly one ceiling: the platform function timeout, 300 seconds. The user
// sat looking at nothing for up to five minutes and then got a cut connection, which is
// served as a blank page on an HTTP 200 that no log records as a failure.
//
// postgrest-js also retries a GET three times with 1s / 2s / 4s backoff on a network
// failure, so one flaky read silently adds seven seconds before it even gives up.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE TWO NUMBERS DIFFER, MEASURED RATHER THAN CHOSEN
//
// Read back from pg_roles on the live database, 2026-09-07:
//
//   authenticated   statement_timeout = 8s
//   service_role    statement_timeout = NULL      <- no ceiling at all
//   anon            statement_timeout = 3s
//
// SESSION_READ_TIMEOUT_MS is 10s, deliberately ABOVE the database's own 8s. Postgres
// gives up first, so this timeout can only ever fire when the network or PostgREST is the
// problem, never part-way through a statement. That is what makes it safe to apply to the
// session client globally, writes included: a write cannot be cut off mid-commit by a
// ceiling that sits two seconds above the one the database already enforces.
//
// SERVICE_READ_TIMEOUT_MS is 8s and must be applied PER CALL SITE. service_role has no
// statement_timeout, so a service-role query genuinely can hang with nothing to stop it.
// That is an argument for bounding the ones a person is waiting on, and against bounding
// them all: the job queue, the agents and the batch sweeps use service-role clients for
// work that is legitimately slow, and a blanket ceiling there would abort real work. So
// the timeout goes on the reads a page renders from, and nowhere else.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT A TIMEOUT LOOKS LIKE TO THE CALLER, WHICH IS THE POINT
//
// postgrest-js converts an abort into { data: null, error: { hint: 'Request was aborted
// (timeout or manual cancellation)' }, status: 0 }. It does NOT throw. So a timeout
// arrives at the caller in exactly the shape a refused or failed read already arrives in,
// and any caller that checks `error` handles all three without knowing which it got.
//
// On the session client the same fetch also serves auth. auth-js wraps any fetch throw,
// abort included, in AuthRetryableFetchError, which is an AuthError, so getUser() returns
// { user: null } rather than throwing. A timed-out auth call is therefore a redirect to
// the login page, not a hang and not a blank screen.

/** Ceiling for the SSR session client. Above the 8s statement_timeout on `authenticated`. */
export const SESSION_READ_TIMEOUT_MS = 10_000

/** Ceiling for a service-role read a page is rendering from. service_role has no DB-side ceiling. */
export const SERVICE_READ_TIMEOUT_MS = 8_000

/**
 * A fetch that gives up after `timeoutMs`.
 *
 * Composed with any signal the caller already passed, so this never silently discards a
 * caller's own abort. If either fires, the request is aborted.
 */
export function fetchWithTimeout(
  timeoutMs: number,
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs)
    const caller = init?.signal
    // AbortSignal.any is Node 20+ / all current browsers. Falling back to the timeout
    // alone would drop the caller's abort, which is a leak rather than a degradation.
    const signal = caller ? AbortSignal.any([caller, timeout]) : timeout
    return baseFetch(input as Request, { ...init, signal })
  }
}

/**
 * The signal to hand to `.abortSignal()` on a service-role read a page is waiting on.
 *
 * Exists as a named function rather than an inline AbortSignal.timeout call so that every
 * such read is greppable and they cannot drift to different values.
 */
export function serviceReadSignal(): AbortSignal {
  return AbortSignal.timeout(SERVICE_READ_TIMEOUT_MS)
}
