// The weekly watch verdict and its rendering. Pure: no I/O, so every branch is testable.

import {
  INVENTORY_WARN_WEEKS,
  LEAD_CAPACITY_WARN_WEEKS,
  RAMP_LADDER,
} from './thresholds'
import type { Reading, Verdict, WeeklyWatchReport } from './types'

/**
 * THE INVARIANT: any unreadable source makes ADVANCE unreachable.
 *
 * It iterates the readings OBJECT rather than a list of source names. That is deliberate
 * and structural: a seventh source added to WatchValues lands in this loop automatically,
 * because there is no second list to forget to update. The parallel-array bug that hid
 * MON-019 for weeks cannot be expressed here.
 */
export function verdictFor(report: WeeklyWatchReport): Verdict {
  const readings: Reading<unknown>[] = Object.values(report.readings)

  // Unknown wins over everything. We are not judging the numbers, we are saying we do
  // not have them.
  if (readings.some(r => r.status === 'unknown')) return 'INCOMPLETE'

  return concernsFor(report).length > 0 ? 'HOLD' : 'ADVANCE'
}

/**
 * The reasons to hold, from sources that WERE readable.
 *
 * Unknown sources contribute nothing here on purpose: an unreadable source is not
 * evidence of a problem, and dressing it up as one would train the reader to ignore the
 * list. It is handled by the verdict instead.
 */
export function concernsFor(report: WeeklyWatchReport): string[] {
  const concerns: string[] = []
  const r = report.readings

  if (r.warmupCanary.status === 'ok') {
    const { totalLandedSpam, mailboxes } = r.warmupCanary.value
    if (totalLandedSpam > 0) {
      const named = mailboxes.filter(m => m.landedSpam > 0).map(m => m.mailbox).join(', ')
      concerns.push(
        `CANARY: ${totalLandedSpam} warmup email(s) landed in spam (${named}). ` +
        `Warmup degrades before prospect mail does. Roll back a rung.`
      )
    }
  }

  if (r.bounces.status === 'ok' && r.bounces.value.verdict.state === 'failing') {
    concerns.push(`BOUNCES: ${r.bounces.value.verdict.detail}`)
  }

  if (r.accounts.status === 'ok' && r.accounts.value.inactive.length > 0) {
    concerns.push(
      `ACCOUNTS: ${r.accounts.value.inactive.length} sender(s) not active: ` +
      `${r.accounts.value.inactive.join(', ')}.`
    )
  }

  if (r.leadCapacity.status === 'ok') {
    const { weeksRemaining, remaining } = r.leadCapacity.value
    if (weeksRemaining !== null && weeksRemaining < LEAD_CAPACITY_WARN_WEEKS) {
      concerns.push(
        `LEAD CAP: ${remaining} lead(s) of headroom, about ${weeksRemaining.toFixed(1)} week(s) ` +
        `at current burn. The add-on needs a plan change first, so this is lead time, not a setting.`
      )
    }
  }

  if (r.inventory.status === 'ok') {
    const { weeksOfInventory, pending } = r.inventory.value
    if (weeksOfInventory !== null && weeksOfInventory < INVENTORY_WARN_WEEKS) {
      concerns.push(
        `INVENTORY: ${pending} prospect(s) pending upload, about ` +
        `${weeksOfInventory.toFixed(1)} week(s) at current burn. Sourcing is the constraint.`
      )
    }
  }

  return concerns
}

// ── Rendering ────────────────────────────────────────────────────────────────

/**
 * Renders one source. The ONLY place a reading becomes text.
 *
 * The unknown branch returns the reason and no figures at all, so there is no code path
 * on which an unread source can emit a number. That is the guarantee the whole report
 * rests on, and render-never-emits-a-number-for-unknown is what the tests pin.
 */
function line<T>(label: string, reading: Reading<T>, describe: (value: T) => string[]): string[] {
  if (reading.status === 'unknown') {
    return [`${label}: UNKNOWN`, `    reason: ${reading.reason}`]
  }
  return [`${label}: read`, ...describe(reading.value).map(l => `    ${l}`)]
}

function weeks(n: number | null): string {
  return n === null ? 'not derivable (no burn observed in the lookback)' : `${n.toFixed(1)} weeks`
}

function burn(n: number | null): string {
  return n === null ? 'no uploads observed in the lookback window' : `${n.toFixed(1)} per week`
}

export function renderReport(report: WeeklyWatchReport): string {
  const verdict  = verdictFor(report)
  const concerns = concernsFor(report)
  const r        = report.readings

  const out: string[] = []
  out.push('═══════════════════════════════════════════════════════════════')
  out.push(`WEEKLY WATCH — ${report.generatedAt}`)
  out.push(`VERDICT: ${verdict}`)
  out.push('═══════════════════════════════════════════════════════════════')
  out.push('')

  if (verdict === 'INCOMPLETE') {
    const unread = Object.entries(r).filter(([, v]) => v.status === 'unknown').map(([k]) => k)
    out.push(`!! ${unread.length} of ${Object.keys(r).length} source(s) could not be read: ${unread.join(', ')}.`)
    out.push('!! DO NOT ADVANCE. This is not a clean report. An unread source is not a zero.')
    out.push('')
  } else if (verdict === 'HOLD') {
    out.push('!! DO NOT ADVANCE. All sources read; something below says wait.')
    out.push('')
  } else {
    out.push('All six sources read, and all clear. Safe to advance one rung.')
    out.push('')
  }

  if (concerns.length > 0) {
    out.push('CONCERNS')
    for (const c of concerns) out.push(`  - ${c}`)
    out.push('')
  }

  out.push('1. WARMUP CANARY (landed_spam across all mailboxes)')
  out.push(...line('   status', r.warmupCanary, v => {
    const rows = v.mailboxes.map(m =>
      `${m.mailbox}  sent ${m.sent}  inbox ${m.landedInbox}  spam ${m.landedSpam}` +
      `${m.healthScore !== null ? `  health ${m.healthScore}%` : ''}`)
    const head = [`total landed_spam: ${v.totalLandedSpam} across ${v.mailboxes.length} mailbox(es)`]
    if (v.missing.length > 0) head.push(`NOT RETURNED by the provider: ${v.missing.join(', ')}`)
    return [...head, ...rows]
  }))
  out.push('')

  out.push('2. PER-DOMAIN BOUNCES (last 7 days, absolute and rate)')
  out.push(...line('   status', r.bounces, v => [
    `state: ${v.verdict.state}`,
    v.verdict.detail,
    `newest stats row fetched: ${v.freshestFetch}`,
    ...v.verdict.domains.map(d =>
      `${d.domain}  ${d.bounces}/${d.sends}` +
      `${d.bounceRate !== null ? ` (${(d.bounceRate * 100).toFixed(1)}%)` : ''}  ${d.domainState}`),
  ]))
  out.push('')

  out.push('3. ACCOUNT STATUS')
  out.push(...line('   status', r.accounts, v => {
    const head = [`${v.accounts.length} of ${v.expected.length} campaign sender(s) returned by the provider`]
    if (v.missing.length > 0)  head.push(`NOT RETURNED: ${v.missing.join(', ')}`)
    if (v.inactive.length > 0) head.push(`INACTIVE: ${v.inactive.join(', ')}`)
    else if (v.missing.length === 0) head.push('all active, all warming')
    return head
  }))
  out.push('')

  out.push('4. RAMP POSITION')
  out.push(...line('   status', r.ramp, v => [
    `campaign daily limit: ${v.dailyLimit}`,
    v.rung !== null
      ? `rung ${v.rung} of ${v.ladderLength} on the ladder [${RAMP_LADDER.join(', ')}]`
      : `NOT a ladder rung — expected one of [${RAMP_LADDER.join(', ')}], someone set this by hand`,
    v.nextRung !== null ? `next rung: ${v.nextRung}` : 'at target, no further rung',
    `implies ${v.perMailboxPerDay.toFixed(1)} per mailbox per day across ${v.mailboxCount} mailbox(es)`,
    `implies ${v.perDomainPerWeek.toFixed(0)} per domain per week across ${v.domainCount} domain(s)`,
  ]))
  out.push('')

  out.push('5. LEAD CAP')
  out.push(...line('   status', r.leadCapacity, v => [
    `plan: ${v.planId}`,
    `${v.used} of ${v.limit} used, ${v.remaining} remaining`,
    `burn: ${burn(v.burnPerWeek)}`,
    `headroom: ${weeks(v.weeksRemaining)}`,
  ]))
  out.push('')

  out.push('6. PROSPECT INVENTORY')
  out.push(...line('   status', r.inventory, v => [
    `${v.pending} prospect(s) pending upload`,
    `burn: ${burn(v.burnPerWeek)}`,
    `inventory: ${weeks(v.weeksOfInventory)}`,
  ]))

  return out.join('\n')
}

/** Ladder position for a limit. null when the limit is not a rung. */
export function rungFor(dailyLimit: number): { rung: number | null; nextRung: number | null } {
  const i = RAMP_LADDER.indexOf(dailyLimit as (typeof RAMP_LADDER)[number])
  if (i === -1) {
    const next = RAMP_LADDER.find(v => v > dailyLimit) ?? null
    return { rung: null, nextRung: next }
  }
  return { rung: i + 1, nextRung: i + 1 < RAMP_LADDER.length ? RAMP_LADDER[i + 1] : null }
}
