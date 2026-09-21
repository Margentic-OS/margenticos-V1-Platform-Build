// HOW FAST THE VERIFICATION SWEEP IS ALLOWED TO GO, AND HOW IT HOLDS THAT PACE.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT WAS WRONG
//
// The sweep fired every ten minutes, took forty addresses, slept a flat two seconds
// between them, and stopped. Measured against the clock that is roughly eighty seconds of
// work inside a six-hundred-second period: about 240 addresses an hour against a provider
// that allows 30 a minute, or 1,800. The limit was never the constraint. The BATCH SIZE was,
// and it was a fixed number chosen to fit comfortably inside one request.
//
// Two separate defects, and fixing either alone leaves most of the gap:
//
//   1. THE RUN STOPPED LONG BEFORE ITS REQUEST DID. Forty was sized so that forty two-second
//      waits fit inside a 300-second route with room to spare. Everything after the eightieth
//      second was idle.
//   2. THE FLAT SLEEP UNDERSHOT THE LIMIT BY WHATEVER THE PROBE COST. `sleep(2000)` after a
//      probe that itself took 600ms is a cycle of 2,600ms, which is 23 a minute, not 30. The
//      slower the provider, the further under the limit it drifted, which is exactly backwards.
//
// ═════════════════════════════════════════════════════════════════════════════
// PACE AGAINST A SCHEDULE, NOT AGAINST A STOPWATCH
//
// The pacer below hands out SLOTS at fixed absolute moments rather than sleeping a fixed
// duration between calls. A probe that takes 600ms is followed by a 1,623ms wait; a probe
// that takes 1,900ms is followed by a 323ms wait; the cycle is the interval either way. That
// is what makes the achieved rate the target rate instead of the target minus the provider's
// latency.
//
// AND IT NEVER CATCHES UP. When a probe overruns its whole slot the pacer does NOT fire the
// next few back to back to recover the average. `Math.max(now, earliestNext)` is the line
// that guarantees it. A catch-up burst is precisely the thing a per-minute limit measures:
// an average of 27 a minute made of a quiet stretch and then nine calls in one second is a
// rate-limit breach, however good the average looks.
//
// ═════════════════════════════════════════════════════════════════════════════
// "JUST UNDER" IS A FRACTION, NOT A SUBTRACTION
//
// The target is PACING_SAFETY_FRACTION of whatever the provider allows: 27 a minute against
// a limit of 30. A fraction rather than `limit - 1` because the headroom has to survive the
// limit being raised, which is the whole reason the limit is configuration. At a granted
// limit of 300, `limit - 1` is 299 a minute and a headroom of one call, which is no headroom;
// the fraction gives 270 and a headroom of 30.
//
// The margin is not decoration. Our clock and the provider's differ, requests do not arrive
// in the order they were sent, and a minute boundary on their side can slice a burst we
// think is evenly spread. Ten percent absorbs that. A run that is rate-limited anyway keeps
// the existing retry behaviour unchanged: the attempt is counted, the lock released, and the
// address comes back on a later sweep.

/** The clock and the sleep, injected so a test can measure the pace without waiting for it. */
export interface PacingClock {
  now(): number
  sleep(ms: number): Promise<void>
}

export const systemPacingClock: PacingClock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
}

/**
 * How much of the provider's per-minute allowance the sweep actually aims for.
 *
 * Exported so a test asserts the achieved rate against this rather than against a second
 * copy of 0.9, which is the shape where a fixture and a source of truth drift apart.
 */
export const PACING_SAFETY_FRACTION = 0.9

/**
 * Milliseconds between two probe starts, at the configured limit.
 *
 * ROUNDED UP, always. Rounding down would put the achieved rate fractionally ABOVE the
 * target, and the only direction this number is allowed to be wrong in is slow.
 */
export function pacedIntervalMs(limitPerMinute: number): number {
  if (!Number.isFinite(limitPerMinute) || limitPerMinute <= 0) {
    throw new Error(`A per-minute verification limit must be a positive number, got ${limitPerMinute}`)
  }
  return Math.ceil(60_000 / (limitPerMinute * PACING_SAFETY_FRACTION))
}

/**
 * How many probes fit in a working window, at a given interval.
 *
 * ── IT COUNTS PROBES THAT START STRICTLY BEFORE THE DEADLINE ──
 *
 * Slots fall at 0, i, 2i, ... and a probe is allowed when its slot is strictly inside the
 * window, so the count is `ceil(budget / interval)`.
 *
 * THIS HAS TO AGREE EXACTLY WITH THE LOOP'S OWN DEADLINE TEST, which stops when the next
 * slot is `>= deadlineAt`. The first version returned `floor(budget / interval) + 1`, which
 * counts a probe starting exactly ON the deadline. Everywhere except an exact multiple the
 * two agree, which is what makes the disagreement worth naming: the sizing would select one
 * more row than the loop would ever reach, and that row would be LOCKED and then released
 * unprobed on every run whose window happened to divide evenly. Caught by a test using a
 * window of exactly four intervals.
 *
 * Two numbers that have to track each other, one of which is only wrong on a boundary, is
 * the shape CLAUDE.md keeps naming. They are one expression now and the loop is the
 * authority for what it means.
 */
export function probesWithinBudget(budgetMs: number, intervalMs: number): number {
  if (budgetMs <= 0) return 0
  if (intervalMs <= 0) {
    throw new Error(`A pacing interval must be positive, got ${intervalMs}`)
  }
  return Math.ceil(budgetMs / intervalMs)
}

export interface Pacer {
  /**
   * The earliest moment the next probe may start, without consuming the slot.
   *
   * Read by the deadline check, which has to decide whether there is time for another probe
   * BEFORE committing to waiting for one. A pacer that could only be asked by waiting would
   * force the run to sleep its way up to the deadline and then abandon the wait.
   */
  nextSlotAt(): number
  /** Wait until the next slot opens, consume it, and return the moment it opened. */
  awaitSlot(): Promise<number>
}

export function createPacer(intervalMs: number, clock: PacingClock = systemPacingClock): Pacer {
  if (intervalMs <= 0) {
    throw new Error(`A pacing interval must be positive, got ${intervalMs}`)
  }

  // Null until the first slot is taken: the first probe of a run waits for nothing. A run
  // that opened with a full interval of sleep would give back one slot per run for no reason,
  // and at six runs an hour that is a measurable amount of the thing being optimised.
  let earliestNext: number | null = null

  const slotFor = (now: number): number =>
    earliestNext === null ? now : Math.max(now, earliestNext)

  return {
    nextSlotAt() {
      return slotFor(clock.now())
    },
    async awaitSlot() {
      const now = clock.now()
      // THE NO-CATCH-UP LINE. When the previous probe overran its slot, `earliestNext` is
      // already in the past and this resolves to `now`, so the run resumes at the correct
      // pace from here rather than firing the backlog of missed slots at once.
      const slot = slotFor(now)
      const wait = slot - now
      if (wait > 0) await clock.sleep(wait)
      earliestNext = slot + intervalMs
      return slot
    },
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// THE WORKING WINDOW
//
// Two independent ceilings, and the run gets the smaller:
//
//   THE REQUEST. The route is capped at 300 seconds. A probe can take 20 (the handler's own
//   fetch timeout), and the tail after the loop has to write the run's results, the
//   heartbeat, and flush Sentry. So the last probe must START with enough left for both.
//
//   THE PERIOD. A run must finish before the next firing of the same job. Two overlapping
//   sweeps each pacing at 27 a minute spend 54 a minute against a limit of 30, and neither
//   is doing anything wrong on its own. This is the ceiling that makes the pacing safe
//   ACROSS runs rather than only within one, and it is derived from the schedule rather than
//   assumed, so moving the job from every ten minutes to every five needs no code change.

/** Route cap, less the worst-case final probe and the tail that follows the loop. */
export const DEFAULT_RUN_BUDGET_MS = 240_000

/**
 * Gap left between a run's deadline and the next firing.
 *
 * Covers the final probe running its full 20-second timeout plus the tail, so the run is
 * finished and its locks released before the next sweep looks for work.
 */
export const OVERLAP_MARGIN_MS = 60_000

/**
 * How long one run may spend probing, given how often the job fires.
 *
 * A null period means the schedule could not be read or was not a minute interval. The
 * compiled budget is then used unchanged: it is correct for every schedule at or above one
 * firing per five minutes, which covers every shape this job has ever had.
 */
export function runBudgetMs(periodMs: number | null): number {
  if (periodMs === null || !Number.isFinite(periodMs) || periodMs <= 0) {
    return DEFAULT_RUN_BUDGET_MS
  }
  return Math.max(0, Math.min(DEFAULT_RUN_BUDGET_MS, periodMs - OVERLAP_MARGIN_MS))
}
