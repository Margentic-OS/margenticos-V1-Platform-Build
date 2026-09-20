// SAYING WHICH SOURCING RUNS A COUNT COVERS.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY
//
// Every actionable count on the pipeline screen is an all-time total for the client, and
// none of them said so. "Research 62 prospects", "Approve 100 prospects", "Check 190 and
// publish" each read as one batch. On the live organisation they were five.
//
// The cards above the buttons already carry the line "All N sourcing runs added together.
// Per run below", added when the same defect was found there. The BUTTONS did not, and a
// button is the worse place for it: a card is read, a button is pressed.
//
// This is the wording, in one place, so the six controls that need it cannot each invent
// their own phrasing or their own arithmetic.
//
// ═════════════════════════════════════════════════════════════════════════════
// NOTHING HERE DECIDES WHAT A COUNT IS. It takes a total and a latest-run figure that the
// caller already holds and words the difference. Pure: no reads, no dates computed, no
// rounding.

/** "2026-09-17" or an ISO timestamp -> "17 Sep 2026". Shared with the client roster. */
import { formatDayLabel } from '@/lib/dashboard/prospect-roster'

export interface RunSplit {
  /** The whole count, across every run. */
  total: number
  /** How many of it came from the most recent sourcing run. */
  fromLatestRun: number
  /** When that run started, for the label. Null when it was never recorded. */
  latestRunStartedAt: string | null
}

/**
 * One sentence naming the runs a count covers, or null when it covers only one.
 *
 * NULL WHEN THERE IS NOTHING TO DISCLOSE, deliberately. A count that does not span runs is
 * not ambiguous, and adding "all 1 run" to every control would bury the cases that matter in
 * cases that do not. The rule this implements is "say so when it spans more than one run",
 * not "annotate everything".
 *
 * A zero total returns null for the same reason: there is no count to qualify.
 */
export function describeRunSplit(split: RunSplit): string | null {
  const { total, fromLatestRun, latestRunStartedAt } = split
  if (total <= 0) return null

  const carriedOver = total - fromLatestRun

  // Nothing carried over: the count IS the latest run, so there is no spread to disclose.
  // Also covers the case where a caller could not attribute anything and passed the total.
  if (carriedOver <= 0) return null

  const runName = latestRunStartedAt
    ? `the run on ${formatDayLabel(latestRunStartedAt)}`
    : 'the most recent run'

  // fromLatestRun can legitimately be 0: every prospect in this count predates the newest
  // run. Worded as "none ... all carried over" rather than "0 from", because a sentence
  // beginning with a zero reads as an error rather than as a fact.
  if (fromLatestRun === 0) {
    return `None of these came from ${runName}. All ${carriedOver} carried over from earlier runs.`
  }

  return `${fromLatestRun} from ${runName}, ${carriedOver} carried over from earlier runs.`
}
