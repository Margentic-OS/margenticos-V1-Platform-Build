// HOW OFTEN A pg_cron JOB FIRES, AND WHEN IT NEXT WILL.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS
//
// Two callers need the same fact and neither can be trusted to restate it:
//
//   the verification sweep   needs its own PERIOD, to size the time budget one run may
//                            use. A run that overruns its period meets the next firing,
//                            and two runs pacing against the same per-minute provider
//                            limit spend it twice over.
//   the operator screen      needs the NEXT FIRING, so "waiting to be checked: 38" can
//                            say when that stops being true.
//
// The period was previously written down in three places that could not see each other:
// the live pg_cron row, `cron_schedule_registry.schedule`, and a `schedule` literal inside
// the route's Sentry monitor config. On 2026-09-21 the live job read `4-59/10` and the
// route's own literal read `*/10`. Nothing was broken by that, because nothing consumed
// either one. The moment something does, they have to agree, and the way to make them
// agree is to read one of them rather than to add a fourth.
//
// cron_schedule_registry is the one read here. It is the DECLARED side, it is held to the
// live side by MON-025, and unlike pg_cron's own catalog it is reachable from the
// application with an ordinary service-role select.
//
// ═════════════════════════════════════════════════════════════════════════════
// IT PARSES ONE SHAPE AND REFUSES EVERYTHING ELSE
//
// This is not a cron implementation and must never grow into one. It understands the
// minute-stepped shapes this project actually schedules with:
//
//   *  *  *  *  *      every minute
//   */10 * * * *       every 10 minutes, on the hour
//   4-59/10 * * * *    every 10 minutes, offset 4 (the stagger, see the 2026-09-10 migration)
//   30 * * * *         once an hour, at minute 30
//
// Anything else — a day field, a list, a named weekday, a step in any other position —
// returns null. A NULL IS THE HONEST ANSWER AND EVERY CALLER HANDLES IT: the sweep falls
// back to its own compiled budget, the screen says it does not know rather than printing a
// time it guessed. Widening the parser to cover `19 3 * * *` would mean returning a period
// of one day to a caller sizing a 300-second request, which is worse than refusing.

/** A schedule that fires every `stepMinutes`, starting at `offsetMinutes` past the hour. */
export interface CronMinuteInterval {
  stepMinutes: number
  offsetMinutes: number
}

/** How far ahead nextRunAfter is willing to look before giving up. */
const MAX_SCAN_MINUTES = 24 * 60

/**
 * Read a five-field crontab as a plain minute interval, or null if it is not one.
 *
 * The four non-minute fields must all be `*`. A schedule that pins an hour or a day does
 * not have "a period" in the sense either caller means, and pretending otherwise is how a
 * daily retention job would hand the sweep a 24-hour budget.
 */
export function parseMinuteInterval(schedule: string): CronMinuteInterval | null {
  const fields = schedule.trim().split(/\s+/)
  if (fields.length !== 5) return null

  const [minute, ...rest] = fields
  if (rest.some(f => f !== '*')) return null

  // Every minute.
  if (minute === '*') return { stepMinutes: 1, offsetMinutes: 0 }

  // `*/N` — every N minutes from the top of the hour.
  const bareStep = /^\*\/(\d{1,2})$/.exec(minute)
  if (bareStep) {
    const step = Number(bareStep[1])
    if (!isUsableStep(step)) return null
    return { stepMinutes: step, offsetMinutes: 0 }
  }

  // `M-59/N` — the staggered form. The range end is required to be 59 because that is the
  // only form this project writes, and a partial range (`4-30/10`) would stop firing
  // halfway through the hour, which the modulo test below cannot express.
  const staggered = /^(\d{1,2})-59\/(\d{1,2})$/.exec(minute)
  if (staggered) {
    const offset = Number(staggered[1])
    const step = Number(staggered[2])
    if (!isUsableStep(step) || offset < 0 || offset > 59) return null
    // The offset must be the first minute the modulo test admits, or the declared range and
    // the fired minutes are different sets. `14-59/10` fires 14,24,... but `m % 10 === 4`
    // also admits 4, which is outside the range.
    if (offset % step !== offset) return null
    return { stepMinutes: step, offsetMinutes: offset }
  }

  // A single minute value: hourly.
  const single = /^(\d{1,2})$/.exec(minute)
  if (single) {
    const at = Number(single[1])
    if (at < 0 || at > 59) return null
    return { stepMinutes: 60, offsetMinutes: at }
  }

  return null
}

/** A step of 0 would divide by zero downstream; above 60 it is no longer a minute pattern. */
function isUsableStep(step: number): boolean {
  return Number.isInteger(step) && step > 0 && step <= 60
}

/**
 * The first firing strictly after `now`, or null when the schedule is not a minute interval.
 *
 * STRICTLY AFTER, never "at or after". This answers "when does it next run", and a caller
 * standing exactly on a firing minute wants the following one: the current one is either
 * already running or already missed, and neither is in the future.
 *
 * Seconds are discarded rather than rounded. pg_cron fires at the top of a minute, so a
 * time carrying seconds would be a precision the underlying fact does not have.
 */
export function nextRunAfter(schedule: string, now: Date): Date | null {
  const interval = parseMinuteInterval(schedule)
  if (interval === null) return null

  const nowMs = now.getTime()
  if (!Number.isFinite(nowMs)) return null

  const { stepMinutes, offsetMinutes } = interval
  const nowMinute = Math.floor(nowMs / 60_000)

  // A bounded scan rather than arithmetic. The patterns are hourly-repeating and the scan is
  // at most 1,440 cheap integer tests, which costs nothing next to the database read that
  // produced the schedule. Arithmetic here would need a separate case per shape, and a
  // wrong one would be a plausible-looking time rather than an obvious failure.
  for (let minute = nowMinute + 1; minute <= nowMinute + MAX_SCAN_MINUTES; minute++) {
    const minuteOfHour = ((minute % 60) + 60) % 60
    if (minuteOfHour % stepMinutes === offsetMinutes % stepMinutes) {
      return new Date(minute * 60_000)
    }
  }

  // Unreachable for any interval parseMinuteInterval admits, and returned rather than thrown
  // so that a future widening of the parser degrades to "not known" instead of to a crash on
  // an operator screen.
  return null
}
