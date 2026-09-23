// Whether a sourcing run has time for another window, and how big that window may be.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY A SOURCING RUN IS WINDOWED AT ALL
//
// A run executes inside one web request. maxDuration is 300s and the usable budget is
// about 240s once cold start, auth and a slow tail are allowed for. Against that, the time
// one candidate costs is not a constant and is not close to one:
//
//   measured on production sourcing_runs joined to agent_runs, 2026-09-23
//     58 ms per candidate    2026-09-21, target 200, 11,630 ms for 200 candidates
//     60 ms                  2026-09-17, target 100
//     73 ms                  2026-09-21, target 100
//    736 ms                  2026-09-15, target 36
//    907 ms                  2026-09-11, target 50
//    981 ms                  2026-09-15, target 30
//  3,535 ms                  2026-09-15, target 44, 155,521 ms for 44 candidates
//
// That is a 61x span, and it moves between runs on the same code against the same provider.
// So 500 candidates costs anywhere between 29 seconds and 29 minutes, and no fixed estimate
// can tell those apart in advance. The 44-candidate run above spent 155s of a 240s budget on
// 44 people.
//
// ── WHAT WENT WRONG WITHOUT THIS ─────────────────────────────────────────────
//
// The run used to make ONE provider call for the whole batch, dedupe once, write once, and
// advance the per-client cursor once at the very end. A request killed by the platform
// timeout therefore lost the cursor advance for everything it had read, while KEEPING the
// prospects it had already written. Nothing was duplicated, because dedupe is the backstop,
// but nothing moved either: the next press re-read the same window, re-dropped it, and could
// fail the same way forever. Progress was not monotonic.
//
// Windowing makes it monotonic. Each window advances the cursor as soon as its own writes
// land, so a run interrupted at any point has banked every window that finished, and the
// only work at risk is the window in flight.
//
// ── WHY THE FIRST WINDOW IS NEVER REFUSED ────────────────────────────────────
//
// The rate is measured FROM the first window, so before it there is nothing to predict
// with. A guess there would either refuse work that would have fitted, or be no better than
// the no-check behaviour it replaces. Since today's code attempts the whole batch with no
// time check whatsoever, running one window unconditionally is never worse than today and
// is the only way to learn this run's rate. Every window after the first is predicted from
// the one before it.

/**
 * How long a sourcing run may spend before it stops opening windows.
 *
 * 240 seconds against the route's maxDuration of 300, leaving 60 for cold start, auth and a
 * slow tail. This number used to live in sourcing-entry.ts as
 * SOURCING_RUNTIME_BUDGET_SECONDS, which is where its estimate is still used; that constant
 * is now derived from this one.
 *
 * IT LIVES HERE AND NOT THERE ON PURPOSE. sourcing-entry.ts imports the orchestrator, so the
 * orchestrator importing sourcing-entry back would be a circular import, and a circular import
 * in this repo passes `tsc --noEmit` and the whole vitest suite and fails only `npm run build`.
 * This module imports nothing, which is what makes it safe for both sides to read.
 */
export const SOURCING_RUNTIME_BUDGET_MS = 240_000

/** One provider page. The sourcing handler's per_page is 100, so a window of 100 is
 *  page-aligned and costs exactly one provider call with nothing skipped at the front. */
export const SOURCING_WINDOW_RECORDS = 100

/**
 * How much slower the next window is allowed to be than the last one before the prediction
 * is wrong in the expensive direction.
 *
 * 1.5, and it is a margin rather than a measurement. Within one run the rate is far steadier
 * than the 61x between-run span above, but a single slow provider page is ordinary and being
 * killed mid-window costs the provider call for that window. Overshooting the estimate
 * costs one window that would have fitted; undershooting costs a killed request with credits
 * already spent, so the asymmetry is deliberate.
 */
export const SOURCING_WINDOW_SAFETY = 1.5

/**
 * Why a run stopped opening windows. Every one of these is reported to the operator: a run
 * that stops short must say which of them it was, because "sourced 100 of 500" means
 * something different in each case.
 */
export type SourcingStopReason =
  /** The whole requested batch was consumed. The ordinary ending. */
  | 'target_met'
  /** Time ran out. More records remain and another press will reach them. */
  | 'budget_exhausted'
  /** The provider has no more rows for this query. Another press changes nothing. */
  | 'provider_exhausted'
  /** The provider's reachable-record ceiling. Only a new ICP filter spec helps. */
  | 'ceiling_reached'

export interface SourcingWindowState {
  /** How many provider records the operator asked this run to consume. */
  targetBatchSize: number
  /** Provider records this run has consumed so far, summed over its finished windows. */
  recordsConsumed: number
  /** Wall-clock milliseconds this run has spent so far. */
  elapsedMs: number
  /** The whole run's runtime budget in milliseconds. */
  budgetMs: number
  /** How long the previous window took. Null before the first window. */
  lastWindowMs: number | null
  /** How many records the previous window actually consumed. Null before the first. */
  lastWindowRecords: number | null
  /** How many records the previous window ASKED for. Null before the first. */
  lastWindowRequested: number | null
  /** True when the previous window reported the provider's reachable-record ceiling. */
  ceilingReached: boolean
  /**
   * True when the previous window reported that the provider has no more rows for this query.
   *
   * THE HANDLER'S OWN WORD, not an inference from a short window. See the note on the
   * provider_exhausted branch below for why the inference is not sufficient on its own.
   */
  resultSetExhausted: boolean
}

export interface SourcingWindowDecision {
  proceed: boolean
  /** Records the next window may consume. Zero when proceed is false. */
  windowRecords: number
  /** Why the run is stopping. Null when proceed is true. */
  stop: SourcingStopReason | null
  /**
   * The prediction this decision was made on, in milliseconds, for the log line.
   *
   * Null on the first window, where there is nothing to predict from. Keeping it on the
   * decision rather than recomputing it at the call site means the number in the log is the
   * number the decision used, not a second calculation that could drift from it.
   */
  predictedMs: number | null
}

/**
 * Whether to open another window, and how big it may be.
 *
 * Pure: no clock, no database, no provider. The caller supplies the elapsed time, which is
 * what makes every branch below reachable from a unit test without waiting for real seconds
 * to pass.
 */
export function planNextWindow(state: SourcingWindowState): SourcingWindowDecision {
  const stop = (reason: SourcingStopReason, predictedMs: number | null = null) =>
    ({ proceed: false, windowRecords: 0, stop: reason, predictedMs })

  // THE CEILING FIRST. Past it the provider returns nothing at all, and an empty result is
  // indistinguishable from a healthy run that found nobody new. Asking again cannot help,
  // and this is the one stop reason where another press is the wrong advice.
  if (state.ceilingReached) return stop('ceiling_reached')

  if (state.recordsConsumed >= state.targetBatchSize) return stop('target_met')

  const remaining = state.targetBatchSize - state.recordsConsumed
  const windowRecords = Math.min(SOURCING_WINDOW_RECORDS, remaining)

  // ── THE FIRST WINDOW ALWAYS RUNS ─────────────────────────────────────────
  // Nothing has been measured yet. See the note at the top of this file.
  if (state.lastWindowMs === null || state.lastWindowRecords === null || state.lastWindowRequested === null) {
    return { proceed: true, windowRecords, stop: null, predictedMs: null }
  }

  // ── THE PROVIDER RAN OUT ─────────────────────────────────────────────────
  //
  // TWO TESTS, AND THE FIRST IS THE ONE THAT MATTERS. resultSetExhausted is the handler saying
  // so directly. A short window is the fallback signal, and on its own it is wrong on the exact
  // boundary: a result set of 300 read in windows of 100 hands back a full 100 every time, so
  // inference alone would open a fourth window and spend a provider call on an empty page to
  // learn what the third window already knew.
  //
  // The short-window test stays because it is the only signal a future handler that does not
  // set the flag could give, and because it costs nothing to keep.
  //
  // CHECKED BEFORE THE TIME ARITHMETIC, and also because that arithmetic divides by
  // lastWindowRecords. A zero-record window would divide by zero here.
  if (state.resultSetExhausted) return stop('provider_exhausted')
  if (state.lastWindowRecords < state.lastWindowRequested) return stop('provider_exhausted')

  const perRecordMs = state.lastWindowMs / state.lastWindowRecords
  const predictedMs = perRecordMs * windowRecords * SOURCING_WINDOW_SAFETY

  if (state.elapsedMs + predictedMs > state.budgetMs) return stop('budget_exhausted', predictedMs)

  return { proceed: true, windowRecords, stop: null, predictedMs }
}

/**
 * The sentence the operator reads when a run stops short.
 *
 * ONE PLACE, so the API response, the run record and the log cannot describe the same
 * outcome three different ways. `remaining` is records of the REQUESTED batch that were
 * never attempted, not prospects that failed to be written.
 */
export function describeStop(
  stop: SourcingStopReason,
  recordsConsumed: number,
  targetBatchSize: number,
): string {
  const remaining = Math.max(0, targetBatchSize - recordsConsumed)

  switch (stop) {
    case 'target_met':
      return `Sourced the full batch of ${targetBatchSize}.`
    case 'budget_exhausted':
      return (
        `Read ${recordsConsumed} of ${targetBatchSize} before this run's time budget ran out. ` +
        `${remaining} remain. The position is saved, so pressing Source again picks up exactly ` +
        'where this run stopped rather than starting over.'
      )
    case 'provider_exhausted':
      return (
        `Read ${recordsConsumed} of ${targetBatchSize}. The provider has no more people ` +
        'matching this ICP, so pressing again will not find any. Widen or change the ICP ' +
        'filter spec to reach more.'
      )
    case 'ceiling_reached':
      return (
        `Read ${recordsConsumed} of ${targetBatchSize}. This client has now consumed every ` +
        'record the provider will page to for this ICP. Further runs cannot return anyone ' +
        'new: the ICP filter spec has to change.'
      )
  }
}
