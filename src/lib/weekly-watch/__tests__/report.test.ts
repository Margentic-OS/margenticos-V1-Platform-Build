// The weekly watch's one job: an unread source must never render as a number.
//
// The central test here is a MUTATION test in the CLAUDE.md sense. It does not assert
// that the happy path prints nice figures. It makes each source unreadable in turn and
// proves the report changes shape — verdict, banner and section — rather than quietly
// substituting a zero. If someone later gives Reading a default, these go red.

import { describe, expect, it } from 'vitest'
import { concernsFor, renderReport, rungFor, verdictFor } from '../report'
import { RAMP_LADDER } from '../thresholds'
import { ok, unknown, type WatchSource, type WeeklyWatchReport } from '../types'
import type { SendingHealthVerdict } from '@/lib/sending-health/evaluate'

const CLEAN_BOUNCE_VERDICT: SendingHealthVerdict = {
  state: 'healthy',
  domains: [
    { domain: 'a.com', sends: 60, bounces: 0, bounceRate: 0, rateState: 'within_threshold', absoluteBreach: false, domainState: 'healthy' },
  ],
  windowStart: '2026-09-11',
  windowEnd: '2026-09-17',
  detail: 'All 1 domain(s) within threshold.',
}

/** A report in which every source read cleanly. The baseline the mutations depart from. */
function cleanReport(): WeeklyWatchReport {
  return {
    generatedAt: '2026-09-17T13:00:00.000Z',
    readings: {
      warmupCanary: ok({
        mailboxes: [
          { mailbox: 'a@a.com', sent: 70, landedInbox: 70, landedSpam: 0, healthScore: 100 },
          { mailbox: 'b@a.com', sent: 70, landedInbox: 70, landedSpam: 0, healthScore: 100 },
        ],
        totalLandedSpam: 0,
        missing: [],
      }),
      bounces: ok({ verdict: CLEAN_BOUNCE_VERDICT, freshestFetch: '2026-09-17T12:00:00.000Z' }),
      accounts: ok({
        expected: ['a@a.com', 'b@a.com'],
        accounts: [
          { mailbox: 'a@a.com', active: true, warmupActive: true },
          { mailbox: 'b@a.com', active: true, warmupActive: true },
        ],
        inactive: [],
        missing: [],
      }),
      ramp: ok({
        dailyLimit: 40, mailboxCount: 10, domainCount: 5,
        perMailboxPerDay: 4, perDomainPerWeek: 40,
        rung: 2, ladderLength: 6, nextRung: 55,
      }),
      leadCapacity: ok({
        planId: 'pid_g_v2', limit: 1000, used: 95, remaining: 905,
        burnPerWeek: 30, weeksRemaining: 30.2,
      }),
      inventory: ok({ pending: 197, burnPerWeek: 30, weeksOfInventory: 6.6 }),
    },
  }
}

/**
 * The sources, derived from a real report rather than hand-listed.
 *
 * Hand-listing them would be the parallel-array bug this module is written to avoid: a
 * seventh source would be added to the type and silently never mutation-tested.
 */
const ALL_SOURCES = Object.keys(cleanReport().readings) as WatchSource[]

describe('the weekly watch baseline', () => {
  it('advances only when every source read and all are clear', () => {
    expect(verdictFor(cleanReport())).toBe('ADVANCE')
    expect(concernsFor(cleanReport())).toEqual([])
  })

  it('covers exactly the six sources the watch is specified to read', () => {
    expect(ALL_SOURCES.sort()).toEqual(
      ['accounts', 'bounces', 'inventory', 'leadCapacity', 'ramp', 'warmupCanary'],
    )
  })
})

describe('MUTATION: one unreadable source', () => {
  // The invariant, over every source. This is the test that must go red if anyone ever
  // makes an unknown reading fall back to a default.
  it.each(ALL_SOURCES)('%s unreadable makes ADVANCE unreachable', source => {
    const report = cleanReport()
    report.readings[source] = unknown('the probe could not reach the source')

    expect(verdictFor(report)).toBe('INCOMPLETE')
    expect(verdictFor(report)).not.toBe('ADVANCE')
  })

  it.each(ALL_SOURCES)('%s unreadable renders UNKNOWN and its stated reason', source => {
    const report = cleanReport()
    report.readings[source] = unknown('SENTINEL_REASON_42')

    const text = renderReport(report)
    expect(text).toContain('UNKNOWN')
    expect(text).toContain('SENTINEL_REASON_42')
    expect(text).toContain('DO NOT ADVANCE')
    expect(text).toContain('An unread source is not a zero')
  })

  it.each(ALL_SOURCES)('%s unreadable names itself in the banner', source => {
    const report = cleanReport()
    report.readings[source] = unknown('nope')
    expect(renderReport(report)).toContain(`could not be read: ${source}`)
  })
})

describe('MUTATION: a real zero and an unreadable source must not look the same', () => {
  it('a canary that read zero spam prints a zero; one that could not be read prints none', () => {
    const readZero = renderReport(cleanReport())
    expect(readZero).toContain('total landed_spam: 0')
    expect(readZero).toContain('VERDICT: ADVANCE')

    const unread = cleanReport()
    unread.readings.warmupCanary = unknown('warmup analytics unreadable: HTTP 503')
    const unreadText = renderReport(unread)

    // The whole point: no zero is emitted for the source that was not read.
    expect(unreadText).not.toContain('total landed_spam: 0')
    expect(unreadText).not.toContain('total landed_spam')
    expect(unreadText).toContain('warmup analytics unreadable: HTTP 503')
    expect(unreadText).toContain('VERDICT: INCOMPLETE')
    expect(unreadText).not.toContain('VERDICT: ADVANCE')
  })

  it('an unreadable bounce source prints no domain rows and no percentage', () => {
    const unread = cleanReport()
    unread.readings.bounces = unknown('bounce stats are stale: newest row fetched 96h ago')
    const text = renderReport(unread)

    expect(text).not.toContain('0/60')
    expect(text).not.toContain('(0.0%)')
    expect(text).not.toContain('healthy')
    expect(text).toContain('stale')
  })

  it('an unreadable lead cap prints neither the limit nor a headroom figure', () => {
    const unread = cleanReport()
    unread.readings.leadCapacity = unknown('plan is pid_hg_v1, but the 1000 lead limit was measured for pid_g_v2')
    const text = renderReport(unread)

    expect(text).not.toContain('905 remaining')
    expect(text).not.toContain('of 1000 used')
    expect(text).toContain('pid_hg_v1')
  })

  it('several unreadable sources are all named, not just the first', () => {
    const report = cleanReport()
    report.readings.warmupCanary = unknown('a')
    report.readings.inventory = unknown('b')
    const text = renderReport(report)
    expect(text).toContain('2 of 6 source(s) could not be read')
    expect(text).toContain('warmupCanary')
    expect(text).toContain('inventory')
  })
})

describe('HOLD is distinct from INCOMPLETE', () => {
  it('holds when the canary shows spam, with every source readable', () => {
    const report = cleanReport()
    report.readings.warmupCanary = ok({
      mailboxes: [{ mailbox: 'a@a.com', sent: 70, landedInbox: 68, landedSpam: 2, healthScore: 92 }],
      totalLandedSpam: 2,
      missing: [],
    })
    expect(verdictFor(report)).toBe('HOLD')
    expect(concernsFor(report)[0]).toContain('CANARY')
    expect(renderReport(report)).toContain('DO NOT ADVANCE')
  })

  it('holds on a failing bounce verdict', () => {
    const report = cleanReport()
    report.readings.bounces = ok({
      verdict: { ...CLEAN_BOUNCE_VERDICT, state: 'failing', detail: '1 domain(s) over threshold' },
      freshestFetch: '2026-09-17T12:00:00.000Z',
    })
    expect(verdictFor(report)).toBe('HOLD')
    expect(concernsFor(report)[0]).toContain('BOUNCES')
  })

  it('holds on an inactive sender', () => {
    const report = cleanReport()
    report.readings.accounts = ok({
      expected: ['a@a.com'],
      accounts: [{ mailbox: 'a@a.com', active: false, warmupActive: true }],
      inactive: ['a@a.com'],
      missing: [],
    })
    expect(verdictFor(report)).toBe('HOLD')
    expect(concernsFor(report)[0]).toContain('ACCOUNTS')
  })

  it('holds when the lead cap is within three weeks', () => {
    const report = cleanReport()
    report.readings.leadCapacity = ok({
      planId: 'pid_g_v2', limit: 1000, used: 940, remaining: 60, burnPerWeek: 30, weeksRemaining: 2,
    })
    expect(verdictFor(report)).toBe('HOLD')
    expect(concernsFor(report)[0]).toContain('LEAD CAP')
  })

  it('holds when inventory is under two weeks', () => {
    const report = cleanReport()
    report.readings.inventory = ok({ pending: 20, burnPerWeek: 30, weeksOfInventory: 0.67 })
    expect(verdictFor(report)).toBe('HOLD')
    expect(concernsFor(report)[0]).toContain('INVENTORY')
  })

  it('an unreadable source outranks a concern, because we cannot judge what we did not read', () => {
    const report = cleanReport()
    report.readings.inventory = ok({ pending: 20, burnPerWeek: 30, weeksOfInventory: 0.67 })
    report.readings.accounts = unknown('provider timed out')
    expect(verdictFor(report)).toBe('INCOMPLETE')
    // The concern is still surfaced rather than swallowed by the INCOMPLETE verdict.
    expect(concernsFor(report).some(c => c.includes('INVENTORY'))).toBe(true)
  })
})

describe('a null burn rate is not a zero burn rate', () => {
  it('renders "not derivable" rather than an infinite or zero runway', () => {
    const report = cleanReport()
    report.readings.leadCapacity = ok({
      planId: 'pid_g_v2', limit: 1000, used: 95, remaining: 905, burnPerWeek: null, weeksRemaining: null,
    })
    const text = renderReport(report)
    expect(text).toContain('no uploads observed in the lookback window')
    expect(text).toContain('not derivable')
    expect(text).not.toContain('Infinity')
    expect(text).not.toContain('0.0 weeks')
  })

  it('does not hold on a null runway, because null is not "nearly out"', () => {
    const report = cleanReport()
    report.readings.leadCapacity = ok({
      planId: 'pid_g_v2', limit: 1000, used: 95, remaining: 905, burnPerWeek: null, weeksRemaining: null,
    })
    expect(concernsFor(report).some(c => c.includes('LEAD CAP'))).toBe(false)
  })
})

describe('rungFor', () => {
  it('maps each ladder value to a 1-based rung', () => {
    expect(rungFor(25)).toEqual({ rung: 1, nextRung: 40 })
    expect(rungFor(40)).toEqual({ rung: 2, nextRung: 55 })
    expect(rungFor(120)).toEqual({ rung: 6, nextRung: null })
  })

  it('reports a hand-set limit as off-ladder rather than rounding it to a rung', () => {
    expect(rungFor(37)).toEqual({ rung: null, nextRung: 40 })
    expect(renderReport({
      ...cleanReport(),
      readings: {
        ...cleanReport().readings,
        ramp: ok({
          dailyLimit: 37, mailboxCount: 10, domainCount: 5,
          perMailboxPerDay: 3.7, perDomainPerWeek: 37,
          rung: null, ladderLength: 6, nextRung: 40,
        }),
      },
    })).toContain('NOT a ladder rung')
  })

  it('the ladder is the one agreed, so a silent edit fails here', () => {
    expect([...RAMP_LADDER]).toEqual([25, 40, 55, 75, 95, 120])
  })
})
