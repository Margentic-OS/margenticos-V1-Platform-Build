// Per-domain sending health: the judgement, as pure functions.
//
// WHY THE JUDGEMENT LIVES HERE AND NOT IN THE mon_023 VIEW.
//
// Every other monitor computes its state in SQL. This one cannot, and the reason is
// testability rather than taste. A threshold expressed in a view can only be exercised
// against a database, the only database this project has is production, and
// vitest.config.ts forbids pointing the test suite at it — which is why the one existing
// test of a monitor view, mon_006_per_row.test.ts, has never executed a single assertion.
// A threshold nothing can run a test against is a threshold nobody has checked.
//
// So the arithmetic lives in TypeScript where vitest can reach it, the cron writes the
// verdict to a table, and mon_023 reads that verdict and adds the one thing that must be
// evaluated at read time: whether the verdict is still fresh. MON-016 already reads a
// stored verdict this way (cron_heartbeats.ok), so the sweep needs no special case.
//
// Decided with Doug 2026-08-27 after the conflict was surfaced rather than worked around.

import {
  ABSOLUTE_BOUNCE_TRIGGER,
  RATE_BOUNCE_TRIGGER,
  RATE_MINIMUM_SENDS,
  SENDING_HEALTH_WINDOW_DAYS,
} from './thresholds'

/** One day of one mailbox, as stored in sending_mailbox_daily_stats. */
export interface MailboxDailyStat {
  statDate: string   // YYYY-MM-DD
  domain:   string
  sends:    number
  bounces:  number
}

/**
 * How trigger 2 came out for one domain.
 *
 * THREE VALUES, NOT TWO. 'insufficient_sends' is not a kind of pass. It means the rate
 * rule declined to judge because the denominator was too small, and it must stay
 * distinguishable from a domain that was judged and found clean, all the way through to
 * the operator's screen.
 */
export type DomainRateState = 'insufficient_sends' | 'within_threshold' | 'breach'

/** The whole verdict for one domain, both triggers combined. */
export type DomainState = 'healthy' | 'insufficient_sends' | 'breach'

export interface DomainHealth {
  domain:         string
  sends:          number
  bounces:        number
  /** null when the domain sent nothing: 0/0 is not 0%, it is undefined. */
  bounceRate:     number | null
  rateState:      DomainRateState
  absoluteBreach: boolean
  domainState:    DomainState
}

/**
 * The verdict across all domains.
 *
 *   'no_data'            nothing in the window at all
 *   'insufficient_sends' nothing breached, and NO domain cleared the floor, so trigger 2
 *                        judged nothing. Reported separately from 'healthy' on purpose.
 *   'healthy'            at least one domain was judged by both triggers and passed
 *   'failing'            at least one domain breached at least one trigger
 */
export type OverallHealthState = 'no_data' | 'insufficient_sends' | 'healthy' | 'failing'

export interface SendingHealthVerdict {
  state:       OverallHealthState
  domains:     DomainHealth[]
  windowStart: string
  windowEnd:   string
  detail:      string
}

/**
 * Derives the sending domain from a mailbox address.
 *
 * Not tool-specific, so it belongs here rather than in a handler: an email address has
 * the same shape whichever vendor is sending through it. Lowercased because Instantly
 * returns addresses as the user typed them and 'Doug@X.com' and 'doug@x.com' are one
 * domain, not two, which would otherwise split a domain's sends across two rows and
 * halve its apparent bounce rate.
 *
 * Returns null for anything without exactly one '@' and a non-empty both sides. A caller
 * that gets null must drop the row loudly rather than invent a domain for it.
 */
export function deriveSendingDomain(mailbox: string): string | null {
  const trimmed = mailbox.trim().toLowerCase()
  const parts = trimmed.split('@')
  if (parts.length !== 2) return null
  const [local, domain] = parts
  if (local.length === 0 || domain.length === 0) return null
  if (!domain.includes('.')) return null
  return domain
}

/**
 * Inclusive list of the YYYY-MM-DD dates in the window ending on `windowEnd`.
 * Exported so the caller and the tests agree on what "last seven days" means rather than
 * each computing it.
 */
export function sendingHealthWindow(windowEnd: Date): { start: string; end: string } {
  const end = new Date(Date.UTC(
    windowEnd.getUTCFullYear(), windowEnd.getUTCMonth(), windowEnd.getUTCDate()
  ))
  const start = new Date(end)
  // Inclusive of both ends: a 7-day window is today and the six days before it.
  start.setUTCDate(start.getUTCDate() - (SENDING_HEALTH_WINDOW_DAYS - 1))
  return { start: toDateString(start), end: toDateString(end) }
}

function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * Evaluates one domain's rows. Exported for direct testing of the trigger boundaries.
 */
export function evaluateDomain(domain: string, sends: number, bounces: number): DomainHealth {
  const bounceRate = sends > 0 ? bounces / sends : null

  // TRIGGER 1 — absolute. Applies at any volume, including below the rate floor. This is
  // the trigger that is actually live at today's throughput.
  const absoluteBreach = bounces >= ABSOLUTE_BOUNCE_TRIGGER

  // TRIGGER 2 — proportional, and only above the floor.
  let rateState: DomainRateState
  if (sends < RATE_MINIMUM_SENDS) {
    rateState = 'insufficient_sends'
  } else if (bounceRate !== null && bounceRate > RATE_BOUNCE_TRIGGER) {
    rateState = 'breach'
  } else {
    rateState = 'within_threshold'
  }

  // A breach on either trigger is a breach. Below the floor with no absolute breach is
  // NOT healthy, because half the check declined to run.
  let domainState: DomainState
  if (absoluteBreach || rateState === 'breach') {
    domainState = 'breach'
  } else if (rateState === 'insufficient_sends') {
    domainState = 'insufficient_sends'
  } else {
    domainState = 'healthy'
  }

  return { domain, sends, bounces, bounceRate, rateState, absoluteBreach, domainState }
}

/**
 * Rolls daily mailbox rows up to per-domain health for the window ending at `now`.
 *
 * Rows outside the window are ignored rather than rejected, so a caller may hand over
 * everything it has without pre-filtering and still get a window-accurate answer.
 */
export function evaluateSendingHealth(
  rows: MailboxDailyStat[],
  now: Date,
): SendingHealthVerdict {
  const { start, end } = sendingHealthWindow(now)

  const inWindow = rows.filter(r => r.statDate >= start && r.statDate <= end)

  const byDomain = new Map<string, { sends: number; bounces: number }>()
  for (const row of inWindow) {
    const acc = byDomain.get(row.domain) ?? { sends: 0, bounces: 0 }
    acc.sends   += row.sends
    acc.bounces += row.bounces
    byDomain.set(row.domain, acc)
  }

  const domains = [...byDomain.entries()]
    .map(([domain, t]) => evaluateDomain(domain, t.sends, t.bounces))
    // Worst first, then noisiest, so the detail line leads with what matters.
    .sort((a, b) =>
      rank(b.domainState) - rank(a.domainState) ||
      b.bounces - a.bounces ||
      a.domain.localeCompare(b.domain)
    )

  const state = overallState(domains)

  return { state, domains, windowStart: start, windowEnd: end, detail: buildDetail(state, domains, start, end) }
}

function rank(s: DomainState): number {
  return s === 'breach' ? 2 : s === 'insufficient_sends' ? 1 : 0
}

function overallState(domains: DomainHealth[]): OverallHealthState {
  if (domains.length === 0) return 'no_data'
  if (domains.some(d => d.domainState === 'breach')) return 'failing'
  // Nothing breached. Did trigger 2 actually judge anything?
  if (domains.every(d => d.rateState === 'insufficient_sends')) return 'insufficient_sends'
  return 'healthy'
}

/**
 * The sentence an operator reads. Always carries the numerator AND the denominator,
 * never a bare percentage: "3.4%" on its own is unreadable when the denominator might be
 * 29. Always states how many domains the rate rule declined to judge, so a quiet result
 * cannot be mistaken for a thorough one.
 */
function buildDetail(
  state: OverallHealthState,
  domains: DomainHealth[],
  start: string,
  end: string,
): string {
  const window = `${start} to ${end}`

  if (state === 'no_data') {
    return `No per-mailbox sending data in the window ${window}. Nothing has been judged.`
  }

  const belowFloor = domains.filter(d => d.rateState === 'insufficient_sends').length
  const floorNote =
    belowFloor === 0
      ? ''
      : ` ${belowFloor} of ${domains.length} domain(s) sent fewer than ${RATE_MINIMUM_SENDS} ` +
        `in the window, so the ${pct(RATE_BOUNCE_TRIGGER)} rate rule was not applied to them.`

  if (state === 'failing') {
    const breached = domains.filter(d => d.domainState === 'breach')
    const named = breached.map(d => `${d.domain} ${d.bounces}/${d.sends}${d.bounceRate !== null ? ` (${pct(d.bounceRate)})` : ''}`).join(', ')
    return `${breached.length} domain(s) over threshold in ${window}: ${named}.${floorNote}`
  }

  const worst = domains[0]
  const worstNote = worst
    ? ` Highest: ${worst.domain} ${worst.bounces}/${worst.sends}${worst.bounceRate !== null ? ` (${pct(worst.bounceRate)})` : ''}.`
    : ''

  if (state === 'insufficient_sends') {
    return `No domain reached ${RATE_MINIMUM_SENDS} sends in ${window}, so the rate rule ` +
           `judged nothing. The ${ABSOLUTE_BOUNCE_TRIGGER}-bounce rule was applied and found ` +
           `nothing.${worstNote}`
  }

  return `All ${domains.length} domain(s) within threshold for ${window}.${floorNote}${worstNote}`
}

function pct(r: number): string {
  return `${(r * 100).toFixed(1)}%`
}
