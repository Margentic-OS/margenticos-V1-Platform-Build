// When the monitor sweep records a transition, and when it sends an alert.
//
// SEPARATE MODULE for the same reason as monitors.ts: a Next.js route file may only export
// route handlers, and this has to be importable by its tests.
//
// ═══════════════════════════════════════════════════════════════════════════════
// RECORD THE FIRST FAILURE, ALERT ON THE SECOND
//
// DATABASE-EVIDENCED, production monitor_events, 2026-09-10 18:00 to 2026-09-11 14:05 UTC:
// 19 PROBLEM transitions across six checks (MON-005 x8, MON-002 x4, MON-027 x2, MON-016 x2,
// MON-026 x2, MON-021 x1). Every one was followed by OK, every one raised a Sentry error at
// the moment of transition, and Doug counted about nineteen emails for zero standing faults.
// 16 of the 19 cleared on the very next sweep. Most trace to the Supabase gateway cutting a
// read at five seconds inside the job being watched, which is Supabase's to fix, not this.
//
// So the first PROBLEM reading is RECORDED exactly as before, with alert_pending = true. The
// dashboard, the badge and the history all show it at once; nothing is hidden. Only the
// alert waits one sweep. If the next reading is still PROBLEM it is sent then. If the check
// has recovered, the owed alert is dropped and the PROBLEM row is resolved as usual.
//
// WHAT DOES NOT CHANGE
//   - A failed view read is not a reading. The sweep skips the check, so nothing is
//     recorded, resolved or sent, and a pending alert stays owed until a real reading comes.
//   - UNKNOWN is recorded as UNKNOWN. It is never alerted and never counts as OK.
//   - "Consecutive" means consecutive READINGS. A sweep that could not read the view neither
//     breaks the run nor counts as one of the two.
//
// WHAT THIS CANNOT FIX. A check whose own design holds one failed run red for longer than a
// sweep still alerts on it. MON-026 reads a verdict written every 30 minutes, and MON-021
// counts failures over a 60-minute window. Of the 19 above, those were the 3 that would still
// have sent.
// ═══════════════════════════════════════════════════════════════════════════════

export type MonitorState = 'PROBLEM' | 'OK' | 'UNKNOWN'

export interface PreviousEvent {
  state: MonitorState
  alert_pending: boolean
}

export interface SweepStep {
  /** Insert a transition row. */
  record: boolean
  /** Stamp resolved_at on the previous PROBLEM row, and drop any alert it still owed. */
  resolvePrevious: boolean
  /** The row being inserted is a first PROBLEM reading, so it owes an alert. */
  alertPending: boolean
  /** Send the alert the previous PROBLEM row owes. This is the second reading in a row. */
  alertNow: boolean
}

export function planSweepStep(current: MonitorState, previous: PreviousEvent | null): SweepStep {
  const previousState = previous?.state ?? 'UNKNOWN'

  if (current === previousState) {
    return {
      record: false,
      resolvePrevious: false,
      alertPending: false,
      alertNow: current === 'PROBLEM' && previous?.alert_pending === true,
    }
  }

  return {
    record: true,
    resolvePrevious: previousState === 'PROBLEM',
    alertPending: current === 'PROBLEM',
    alertNow: false,
  }
}
