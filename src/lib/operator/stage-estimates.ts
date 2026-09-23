// HOW LONG A BACKLOG WILL TAKE, AND WHAT MAKES IT MOVE.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY A NUMBER ON ITS OWN IS NOT PROGRESS
//
// The pipeline screen already says "waiting to be checked: 38". An operator reading that
// cannot tell the difference between a queue that drains in ten minutes and one that drains
// tomorrow, and the two call for completely different decisions. The same number sat there
// for the whole of a wait with nothing saying whether anything was coming.
//
// Two different shapes of answer, because the two steps are driven by different things:
//
//   VERIFICATION is on a schedule. Nobody presses anything; it drains on its own at a pace
//                set by the provider's per-minute limit and the job's period. The useful
//                answers are WHEN THE NEXT RUN IS and HOW LONG THE WHOLE BACKLOG TAKES.
//   ENRICHMENT   is pressed. It does at most one batch per press and then stops, however
//                many are waiting. The useful answer is HOW MANY MORE PRESSES, and it has
//                never been on the screen: an operator who pressed once and saw the number
//                fall from 240 to 140 had no way to know that was the design.
//
// ═════════════════════════════════════════════════════════════════════════════
// EVERY ESTIMATE HERE IS ALLOWED TO BE UNAVAILABLE
//
// Each function returns null rather than a fallback when an input it needs is missing. A
// screen that says nothing about the finish time is honest; one that prints a confident
// "about 12 minutes" derived from a period it could not read is not, and it is the second
// kind that gets trusted at exactly the wrong moment.

import { probesWithinBudget, runBudgetMs, pacedIntervalMs } from '@/lib/sourcing/verification-pacing'

// ═════════════════════════════════════════════════════════════════════════════
// VERIFICATION

export interface VerificationDrainInputs {
  /** Addresses this client has waiting. */
  waiting: number
  /** How often the sweep fires, from the schedule. Null when it could not be read. */
  periodMs: number | null
  /** The provider's per-minute allowance, from config. */
  ratePerMinute: number
  /** Milliseconds until the next firing. Null when the schedule could not be read. */
  msUntilNextRun: number | null
}

/**
 * Roughly how long until a verification backlog is empty, in minutes.
 *
 * ── THE ASSUMPTION THIS MAKES, STATED HERE AND ON THE SCREEN ──
 *
 * The sweep serves ONE ORGANISATION PER INVOCATION, oldest backlog first. This estimate
 * assumes this client is the one served each time. With a single client holding work that is
 * exactly right; with three clients holding work it is optimistic by up to a factor of three.
 *
 * It is still worth showing, because the alternative on the screen today is nothing at all,
 * and the failure direction is knowable and bounded rather than arbitrary. The caption says
 * "if this client is served each run" so the reading is not stronger than the number.
 *
 * ── WHY IT IS NOT waiting / ratePerMinute ──
 *
 * That would be the answer if the sweep ran continuously. It does not: it works for a budget
 * and then waits for the next firing. A backlog of 200 at 27 a minute is not 7.4 minutes, it
 * is two runs and the gap between them.
 */
export function estimateVerificationDrainMinutes(
  inputs: VerificationDrainInputs,
): number | null {
  const { waiting, periodMs, ratePerMinute, msUntilNextRun } = inputs

  if (waiting <= 0) return 0
  if (periodMs === null || msUntilNextRun === null) return null
  if (!Number.isFinite(ratePerMinute) || ratePerMinute <= 0) return null

  const intervalMs = pacedIntervalMs(ratePerMinute)
  const probesPerRun = probesWithinBudget(runBudgetMs(periodMs), intervalMs)
  if (probesPerRun <= 0) return null

  const runsNeeded = Math.ceil(waiting / probesPerRun)

  // The wait for the first run, plus a whole period for each run after the first, plus the
  // probing time of the final run. The final run is charged only for what it actually does,
  // because a backlog of 3 finishing in the next run should not report a full budget.
  const inFinalRun = waiting - (runsNeeded - 1) * probesPerRun
  const finalRunMs = Math.max(0, inFinalRun - 1) * intervalMs

  const totalMs = msUntilNextRun + (runsNeeded - 1) * periodMs + finalRunMs

  return Math.max(1, Math.round(totalMs / 60_000))
}

// ═════════════════════════════════════════════════════════════════════════════
// ENRICHMENT

export interface EnrichmentPressPlan {
  /** How many this press will act on, across however many passes it makes. */
  thisPress: number
  /** How many are left over afterwards. Zero when one press clears it. */
  remainingAfter: number
  /** Total presses to clear the backlog, including this one. */
  pressesNeeded: number
  /** How many internal passes this press will make. One pass per perPassLimit prospects. */
  passesThisPress: number
}

/**
 * What one press of Enrich and tier will and will not do.
 *
 * ── THIS CHANGED WHEN THE PRESS STARTED AUTO-CONTINUING ─────────────────────
 *
 * It used to compute presses from the PER-PASS limit of 100, and the screen said "you will
 * need to press it again, 5 presses in total". That is no longer true: one press now makes as
 * many 100-prospect passes as its time budget allows, up to ENRICHMENT_MAX_PER_REQUEST. A
 * screen still promising five presses would be a document asserting something that was never
 * true of the code shipped beside it, which is the failure this project keeps paying for.
 *
 * So there are now TWO numbers and they are different things:
 *   perPassLimit     one call to the enrichment trigger. Still 100. Never raised.
 *   maxPerPress      what one press of the button will get through. The spend ceiling.
 *
 * BOTH ARE PASSED IN, never restated here. They belong to the modules that enforce them, and a
 * second copy is the shape where the screen promises one thing and the button does another.
 *
 * pressesNeeded is computed from maxPerPress, because that is what a press achieves.
 * passesThisPress is computed from perPassLimit, and is reported only so the screen can explain
 * why a press with a large backlog takes a while.
 */
export function planEnrichmentPresses(
  waiting: number,
  perPassLimit: number,
  maxPerPress: number,
): EnrichmentPressPlan | null {
  if (waiting <= 0) return null
  if (!Number.isFinite(perPassLimit) || perPassLimit <= 0) return null
  if (!Number.isFinite(maxPerPress) || maxPerPress <= 0) return null

  const thisPress = Math.min(waiting, maxPerPress)
  return {
    thisPress,
    remainingAfter: waiting - thisPress,
    pressesNeeded: Math.ceil(waiting / maxPerPress),
    passesThisPress: Math.ceil(thisPress / perPassLimit),
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// RENDERING A DURATION

/**
 * "in about 4 minutes", "in under a minute", "in about 2 hours".
 *
 * DELIBERATELY VAGUE ABOVE AN HOUR. The inputs are a cron period and a provider rate limit;
 * neither supports minute precision on a three-hour answer, and printing "in about 187
 * minutes" would claim a resolution the estimate does not have.
 */
export function describeMinutes(minutes: number | null): string | null {
  if (minutes === null || !Number.isFinite(minutes) || minutes < 0) return null
  if (minutes < 1) return 'under a minute'
  if (minutes === 1) return 'about a minute'
  if (minutes < 60) return `about ${Math.round(minutes)} minutes`

  const hours = minutes / 60
  if (hours < 2) return 'about an hour and a half'
  if (hours < 24) return `about ${Math.round(hours)} hours`

  const days = hours / 24
  return days < 2 ? 'about a day' : `about ${Math.round(days)} days`
}
