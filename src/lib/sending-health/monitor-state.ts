// Turns a STORED sending-health verdict plus a clock into the state MON-023 reports.
//
// Split from evaluate.ts because it answers a different question. evaluate.ts asks "are
// the bounces acceptable"; this asks "is that answer still worth believing". The second
// question is the one a stored verdict creates and a live SQL view never had.
//
// FOUR STATES, and the two extra ones are the point:
//
//   healthy             judged, and clean
//   insufficient_sends  judged by the absolute rule only; no domain cleared the rate floor
//   stale               the verdict is too old to trust, whatever it says
//   failing             a domain breached
//
// plus no_data before the first fetch has ever run.
//
// A monitor that reads green because its input stopped arriving is the same defect as one
// that reads green because it had nothing to judge. Both are represented here rather than
// collapsed into OK.

import { VERDICT_MAX_AGE_MINUTES } from './thresholds'
import type { OverallHealthState } from './evaluate'

/** The three values the monitor sweep understands. Not our choice; monitor_events.state. */
export type SweepState = 'OK' | 'PROBLEM' | 'UNKNOWN'

export type MonitorHealthState = OverallHealthState | 'stale'

export interface MonitorStateResult {
  /** What the sweep records and alerts on. */
  state: SweepState
  /** The four-state answer, for the dashboard and for the detail line. */
  healthState: MonitorHealthState
  detail: string
}

export interface MonitorStateInput {
  /** The verdict as last written by the cron. null when nothing has ever been written. */
  storedState: OverallHealthState | null
  /** When that verdict was computed. null when nothing has ever been written. */
  computedAt: Date | null
  /** The stored detail line, reused when the verdict is fresh. */
  storedDetail?: string | null
  now: Date
}

/**
 * THE MAPPING FROM FOUR STATES ONTO THE SWEEP'S THREE, stated once so it can be read:
 *
 *   failing            -> PROBLEM   a domain is over threshold
 *   stale              -> PROBLEM   the fetch stopped; alert, do not wait quietly
 *   no_data            -> UNKNOWN   nothing computed yet; genuinely unknown
 *   insufficient_sends -> OK        the absolute rule ran and passed
 *   healthy            -> OK
 *
 * insufficient_sends maps to OK deliberately, and it is worth saying why rather than
 * leaving it to look careless. Mapping it to UNKNOWN would be more literal but would make
 * the check DARK: the sweep only writes an event on a state CHANGE, and it treats "no
 * prior event" as UNKNOWN, so a check that sits at UNKNOWN from birth never writes a row
 * and renders exactly like MON-008 — registered, silent, and indistinguishable from a
 * monitor nothing queries. OK plus a detail line that says in words that the rate rule
 * judged nothing is honest AND visible. The distinction survives in healthState, which is
 * what the dashboard renders.
 */
export function resolveMonitorState(input: MonitorStateInput): MonitorStateResult {
  const { storedState, computedAt, storedDetail, now } = input

  // ── No verdict has ever been written ──────────────────────────────────────
  if (storedState === null || computedAt === null) {
    return {
      state: 'UNKNOWN',
      healthState: 'no_data',
      detail:
        'No sending-health verdict has been computed yet. This is expected until the ' +
        'first instantly-poll run after deploy; if it persists, the fetch is not running.',
    }
  }

  // ── Freshness gates trust, so it is checked BEFORE the verdict is read ─────
  const ageMinutes = (now.getTime() - computedAt.getTime()) / 60000
  if (ageMinutes > VERDICT_MAX_AGE_MINUTES) {
    return {
      state: 'PROBLEM',
      healthState: 'stale',
      detail:
        `The sending-health verdict is ${Math.round(ageMinutes)} minutes old, past the ` +
        `${VERDICT_MAX_AGE_MINUTES}-minute limit. It was last computed at ` +
        `${computedAt.toISOString()} and said "${storedState}". That answer describes a ` +
        `window that has moved on, so it is not being reported as current. The ` +
        `instantly-poll cron writes this every 15 minutes: check it is still running.`,
    }
  }

  const detail = storedDetail && storedDetail.length > 0
    ? storedDetail
    : `Sending health: ${storedState}.`

  if (storedState === 'failing') {
    return { state: 'PROBLEM', healthState: 'failing', detail }
  }

  // 'no_data' can also be a FRESH verdict: the fetch ran and found no rows in the window.
  // That is different from never having run, and it is not a pass.
  if (storedState === 'no_data') {
    return {
      state: 'UNKNOWN',
      healthState: 'no_data',
      detail,
    }
  }

  return { state: 'OK', healthState: storedState, detail }
}
