// When an unconfirmed meeting bills, and when we chase it before then.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE DEADLINE IS A CALENDAR DATE, NOT A NUMBER OF DAYS.
//
// The decision of 2026-08-24 (Decisions Log, "Bill on held meetings only, with a two-month
// confirmation window"): a meeting occurring in month M rolls unconfirmed onto the M+1
// invoice, and if it is still unconfirmed at the END OF M+1 it bills automatically. That is
// a commercial term the client agrees to, not a default.
//
// So the window is NOT a fixed duration. A meeting on the 1st of a month has about eight
// weeks; one on the 30th has about four. Anything that adds a constant number of days to the
// meeting time is wrong, and wrong in the direction of billing people early.
//
// Everything here is UTC. The database stores timestamptz, the cron job runs in UTC, and a
// local-time month boundary would move the deadline by a day for half the year.
//
// THE 72-HOUR JOB THIS REPLACES. resolve-auto-held marked a meeting held and billable three
// days after its start with no human involved. It was never part of the 2026-08-24 decision.
// It is paused in the database and declared off (20260911210000), and nothing here restores
// that behaviour: the backstop bills at the end of M+1 and only ever with a basis recorded.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The last instant of the month AFTER the month the meeting happened in, UTC.
 *
 * A meeting at any time in January bills, if still unconfirmed, at 28 (or 29) February
 * 23:59:59.999 UTC. Month overflow is handled by Date.UTC, so December rolls into the
 * following January correctly.
 */
export function unconfirmedBillingDeadline(meetingStart: Date): Date {
  const year = meetingStart.getUTCFullYear()
  const month = meetingStart.getUTCMonth()
  // The first instant of M+2, minus a millisecond, is the last instant of M+1. Taking the
  // "last day" directly would need the month-length table this avoids.
  return new Date(Date.UTC(year, month + 2, 1, 0, 0, 0, 0) - 1)
}

/**
 * How many days are left before the deadline, rounded up, floored at zero.
 * Rounded UP so "7 days left" never reads as 6 and drops a meeting off the operator's list
 * on the day they were supposed to see it.
 */
export function daysUntil(deadline: Date, now: Date): number {
  const ms = deadline.getTime() - now.getTime()
  if (ms <= 0) return 0
  return Math.ceil(ms / (24 * 60 * 60 * 1000))
}

/**
 * When the client is chased, counted BACK FROM THE DEADLINE rather than forward from the
 * meeting. Two weeks, one week, two days. A meeting late in the month gets the same three
 * chances as one early in the month, just closer together, which is the point.
 */
export const REMINDER_DAYS_BEFORE_DEADLINE = [14, 7, 2] as const

/**
 * The operator sees a meeting on the "due to bill unconfirmed" list once it is this close to
 * its deadline, so there is still time to chase the client by hand. Seven days, and it must
 * stay greater than or equal to the last reminder above, or the operator would first see a
 * meeting after its final chase had already gone out.
 */
export const OPERATOR_WARNING_DAYS = 7

/**
 * Which reminder, if any, is due now: the smallest threshold the deadline has come inside
 * that is further out than the last one sent. null when none is due.
 *
 * Driven by how many have already been sent rather than by dates, so a job that misses a day
 * (or runs twice) sends each reminder once and never floods.
 */
export function reminderDue(
  deadline: Date,
  now: Date,
  remindersAlreadySent: number,
): { threshold: number; index: number } | null {
  const left = daysUntil(deadline, now)
  for (let index = remindersAlreadySent; index < REMINDER_DAYS_BEFORE_DEADLINE.length; index++) {
    if (left <= REMINDER_DAYS_BEFORE_DEADLINE[index]) return { threshold: REMINDER_DAYS_BEFORE_DEADLINE[index], index }
  }
  return null
}

/** The deadline in words, for an email or an operator screen. UTC, stated as such. */
export function formatDeadline(deadline: Date): string {
  return deadline.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  })
}
