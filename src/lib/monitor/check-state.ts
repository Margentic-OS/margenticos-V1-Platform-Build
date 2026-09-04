// Combining a monitor's definition, its LIVE reading, and its transition history
// into the one shape the operator dashboard renders.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS A MODULE AND NOT INLINE IN THE PAGE
// ─────────────────────────────────────────────────────────────────────────────
//
// It was inline, TWICE: once on first load and once after acknowledging. Two
// copies of the same mapping that had to agree, which is the parallel-array
// defect in another costume. Changing the mapping in one and not the other would
// have produced a board that told the truth until you acknowledged something.
//
// It is also the seam the tests need. A React page cannot be asked "what would
// you display if the view read fails", but this function can.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RULE: LIVE WINS, AND A FALLBACK IS ALWAYS VISIBLE
// ─────────────────────────────────────────────────────────────────────────────
//
// state, detail and the timestamp come from the mon_* view, which is computed at
// read time. monitor_events supplies only what the views cannot: the
// acknowledgement flags and the transition history.
//
// When a view read FAILS we fall back to the last event, and we set from_live
// false so the dashboard can say so. A silent fallback would rebuild the exact
// defect this module was written to fix, and the operator would have no way to
// tell a fresh reading from a three-week-old one. That is the whole bug.

export interface Check {
  code: string
  title: string
  description: string
  category: string
  is_scheduled: boolean
  plain_meaning?: string
  plain_impact?: string
  plain_action?: string
}

export interface MonitorEvent {
  id: number
  check_code: string
  state: 'PROBLEM' | 'OK' | 'UNKNOWN'
  detail: string | null
  created_at: string
  resolved_at: string | null
  acknowledged_at: string | null
  acknowledged_note: string | null
}

export interface LiveReading {
  state: 'PROBLEM' | 'OK' | 'UNKNOWN'
  detail: string | null
  last_run: string | null
}

export interface CheckState {
  check: Check
  current_state: 'PROBLEM' | 'OK' | 'UNKNOWN'
  detail: string | null
  /** The view's own run timestamp. Null for views computed entirely at read time. */
  last_run: string | null
  /** True when state and detail came from the live view rather than a stored event. */
  from_live: boolean
  /** Why the live read failed, when it did. Null otherwise. */
  live_error: string | null
  /** The newest transition row, which carries the acknowledgement. */
  lastEvent: MonitorEvent | undefined
  /** Open means: newest transition is an unresolved PROBLEM. */
  is_open_problem: boolean
  /** Acknowledged AND still open. */
  is_acknowledged: boolean
  /**
   * The live detail no longer matches the detail that was acknowledged.
   * This is the MON-011 case: acknowledged at "2 failed agent run(s)", now 5,
   * with no new row because the state never left PROBLEM.
   */
  detail_changed_since_ack: boolean
}

/** Newest event per check code. Input must be ordered created_at DESC. */
export function latestEventPerCheck(events: MonitorEvent[]): Map<string, MonitorEvent> {
  const map = new Map<string, MonitorEvent>()
  for (const event of events) {
    if (!map.has(event.check_code)) map.set(event.check_code, event)
  }
  return map
}

export function buildCheckStates(
  checks: Check[],
  events: MonitorEvent[],
  live: Record<string, LiveReading>,
  liveErrors: Record<string, string> = {},
): CheckState[] {
  const latest = latestEventPerCheck(events)

  return checks.map(check => {
    const lastEvent = latest.get(check.code)
    const reading = live[check.code]
    const fromLive = reading !== undefined

    const currentState = fromLive
      ? reading.state
      : (lastEvent?.state ?? 'UNKNOWN')

    const detail = fromLive
      ? reading.detail
      : (lastEvent?.detail ?? null)

    const isOpenProblem =
      lastEvent?.state === 'PROBLEM' && lastEvent.resolved_at === null

    const isAcknowledged = isOpenProblem && lastEvent?.acknowledged_at != null

    // Only meaningful while acknowledged, and only when we have a live reading
    // to compare against. Comparing a stored detail to itself would always say
    // "unchanged", which is how this went unnoticed for seven days.
    const detailChangedSinceAck =
      isAcknowledged && fromLive && reading.detail !== (lastEvent?.detail ?? null)

    return {
      check,
      current_state: currentState,
      detail,
      last_run: fromLive ? reading.last_run : null,
      from_live: fromLive,
      live_error: liveErrors[check.code] ?? null,
      lastEvent,
      is_open_problem: isOpenProblem,
      is_acknowledged: isAcknowledged,
      detail_changed_since_ack: detailChangedSinceAck,
    }
  })
}

/**
 * The category sections the board renders, DERIVED from the checks themselves.
 *
 * The page used to hardcode three category names. monitor_checks held five, so
 * MON-017, 018, 022, 023, 024, 025 and 026 appeared in no section at all,
 * including the privilege audit and the suppression audit. Every one of them was
 * invisible from the day it shipped.
 *
 * Deriving the list means a category added in a future migration gets a section
 * automatically. Hardcoding is what made a monitor that exists and is unreachable
 * possible in the first place.
 *
 * KNOWN_CATEGORY_ORDER only fixes the ORDER of the familiar ones. Anything not
 * listed still renders, sorted after them, which is the property that matters.
 */
const KNOWN_CATEGORY_ORDER = ['liveness', 'tier1', 'blind-spot', 'data_integrity', 'unscheduled']

export function categoriesInOrder(checks: CheckState[]): string[] {
  const present = Array.from(new Set(checks.map(c => c.check.category)))
  return present.sort((a, b) => {
    const ia = KNOWN_CATEGORY_ORDER.indexOf(a)
    const ib = KNOWN_CATEGORY_ORDER.indexOf(b)
    if (ia !== -1 && ib !== -1) return ia - ib
    if (ia !== -1) return -1
    if (ib !== -1) return 1
    return a.localeCompare(b)
  })
}

const CATEGORY_TITLES: Record<string, string> = {
  liveness: 'Liveness Checks (Scheduled Crons)',
  tier1: 'Tier 1 Checks (Signal-Based)',
  'blind-spot': 'Blind-Spot Checks',
  data_integrity: 'Data Integrity Checks',
  unscheduled: 'Unscheduled Checks',
}

export function categoryTitle(category: string): string {
  return CATEGORY_TITLES[category] ?? `${category} Checks`
}
