import { describe, it, expect } from 'vitest'
import {
  deriveSendingDomain,
  sendingHealthWindow,
  evaluateDomain,
  evaluateSendingHealth,
  type MailboxDailyStat,
} from '../evaluate'
import {
  ABSOLUTE_BOUNCE_TRIGGER,
  RATE_BOUNCE_TRIGGER,
  RATE_MINIMUM_SENDS,
} from '../thresholds'

/**
 * These tests are the reason the thresholds are in TypeScript at all.
 *
 * Every trigger is tested on BOTH sides of its boundary, so changing any threshold
 * constant necessarily breaks at least one assertion. That is what makes the mutation
 * test meaningful rather than decorative: a threshold with only a one-sided test can be
 * moved in one direction for free.
 */

const NOW = new Date('2026-08-27T12:00:00.000Z')

function row(domain: string, statDate: string, sends: number, bounces: number): MailboxDailyStat {
  return { domain, statDate, sends, bounces }
}

describe('deriveSendingDomain', () => {
  it('takes the domain and lowercases it', () => {
    expect(deriveSendingDomain('someone@Example.com')).toBe('example.com')
  })

  it('lowercases so one domain cannot split into two rows', () => {
    // A split would halve each half's apparent bounce rate, which is the dangerous
    // direction: it hides breaches rather than inventing them.
    expect(deriveSendingDomain('A@Example.COM')).toBe(deriveSendingDomain('b@example.com'))
  })

  it('trims surrounding whitespace', () => {
    expect(deriveSendingDomain('  someone@example.com  ')).toBe('example.com')
  })

  it.each([
    ['no at sign',      'example.com'],
    ['two at signs',    'a@b@example.com'],
    ['empty local',     '@example.com'],
    ['empty domain',    'someone@'],
    ['no dot',          'someone@localhost'],
    ['empty string',    ''],
  ])('returns null for %s so the caller must drop the row loudly', (_label, input) => {
    expect(deriveSendingDomain(input)).toBeNull()
  })
})

describe('sendingHealthWindow', () => {
  it('is seven days inclusive of both ends', () => {
    expect(sendingHealthWindow(NOW)).toEqual({ start: '2026-08-21', end: '2026-08-27' })
  })

  it('ignores the time of day, so the window does not shift within a day', () => {
    const early = sendingHealthWindow(new Date('2026-08-27T00:00:01.000Z'))
    const late  = sendingHealthWindow(new Date('2026-08-27T23:59:59.000Z'))
    expect(early).toEqual(late)
  })
})

// ── The constants themselves ─────────────────────────────────────────────────
describe('threshold constants are pinned to literals', () => {
  /**
   * WHY THIS BLOCK EXISTS, and it is not belt-and-braces.
   *
   * Every boundary test below reads the constant it is testing, so it MOVES WITH the
   * constant and can never notice it changing. Mutation testing found exactly that hole:
   * raising ABSOLUTE_BOUNCE_TRIGGER from 3 to 4 broke nothing at all, because
   * `evaluateDomain(500, ABSOLUTE_BOUNCE_TRIGGER)` is true whatever the constant says.
   * Loosening the trigger, which is the dangerous direction, would have shipped silently.
   *
   * These are policy numbers agreed with Doug on 2026-08-27. Changing one should require
   * deliberately editing this block, not just editing thresholds.ts.
   */
  it('the absolute bounce trigger is 3', () => {
    expect(ABSOLUTE_BOUNCE_TRIGGER).toBe(3)
    // Both sides, with LITERALS, so neither direction of drift is free.
    expect(evaluateDomain('example.com', 500, 3).absoluteBreach).toBe(true)
    expect(evaluateDomain('example.com', 500, 2).absoluteBreach).toBe(false)
  })

  it('the rate trigger is 2%', () => {
    expect(RATE_BOUNCE_TRIGGER).toBe(0.02)
    expect(evaluateDomain('example.com', 1000, 21).rateState).toBe('breach')            // 2.1%
    expect(evaluateDomain('example.com', 1000, 20).rateState).toBe('within_threshold')  // 2.0%
  })

  it('the rate floor is 50 sends', () => {
    expect(RATE_MINIMUM_SENDS).toBe(50)
    expect(evaluateDomain('example.com', 50, 0).rateState).not.toBe('insufficient_sends')
    expect(evaluateDomain('example.com', 49, 0).rateState).toBe('insufficient_sends')
  })
})

// ── TRIGGER 1, the absolute rule ─────────────────────────────────────────────
describe('trigger 1: absolute bounce count', () => {
  it(`does NOT breach at ${ABSOLUTE_BOUNCE_TRIGGER - 1} bounces`, () => {
    const d = evaluateDomain('example.com', 500, ABSOLUTE_BOUNCE_TRIGGER - 1)
    expect(d.absoluteBreach).toBe(false)
  })

  it(`breaches at exactly ${ABSOLUTE_BOUNCE_TRIGGER} bounces`, () => {
    const d = evaluateDomain('example.com', 500, ABSOLUTE_BOUNCE_TRIGGER)
    expect(d.absoluteBreach).toBe(true)
    expect(d.domainState).toBe('breach')
  })

  it('breaches at any rate, including far below the rate threshold', () => {
    // 3 in 10,000 is 0.03%, nowhere near 2%. The absolute rule still fires, which is the
    // whole reason it exists alongside the proportional one.
    const d = evaluateDomain('example.com', 10_000, ABSOLUTE_BOUNCE_TRIGGER)
    expect(d.rateState).toBe('within_threshold')
    expect(d.domainState).toBe('breach')
  })

  it('fires below the rate floor, where trigger 2 declines to judge', () => {
    const d = evaluateDomain('example.com', 20, ABSOLUTE_BOUNCE_TRIGGER)
    expect(d.rateState).toBe('insufficient_sends')
    expect(d.domainState).toBe('breach')
  })
})

// ── TRIGGER 2, the proportional rule, and its floor ──────────────────────────
describe('trigger 2: bounce rate above threshold, above the floor only', () => {
  it(`reports insufficient_sends at ${RATE_MINIMUM_SENDS - 1} sends`, () => {
    const d = evaluateDomain('example.com', RATE_MINIMUM_SENDS - 1, 2)
    expect(d.rateState).toBe('insufficient_sends')
    expect(d.domainState).toBe('insufficient_sends')
  })

  it(`starts judging at exactly ${RATE_MINIMUM_SENDS} sends`, () => {
    // 2 bounces in 50 is 4%, over the 2% line, and 2 is under the absolute trigger.
    // So this asserts trigger 2 alone.
    const d = evaluateDomain('example.com', RATE_MINIMUM_SENDS, 2)
    expect(d.absoluteBreach).toBe(false)
    expect(d.rateState).toBe('breach')
    expect(d.domainState).toBe('breach')
  })

  it(`passes at exactly ${RATE_BOUNCE_TRIGGER * 100}%, which is not "above"`, () => {
    // 1 in 50 is exactly 2.0%. The PRD bands red as "> 2%", so the boundary passes.
    const d = evaluateDomain('example.com', 50, 1)
    expect(d.bounceRate).toBeCloseTo(RATE_BOUNCE_TRIGGER, 10)
    expect(d.rateState).toBe('within_threshold')
    expect(d.domainState).toBe('healthy')
  })

  it('breaches just above the threshold', () => {
    // 3 in 100 is 3%. Uses a denominator where the absolute rule also fires, so this
    // pairs with the test below to separate the two.
    const d = evaluateDomain('example.com', 100, 3)
    expect(d.rateState).toBe('breach')
  })

  it('passes just below the threshold on a large denominator', () => {
    // 2 in 200 is 1%.
    const d = evaluateDomain('example.com', 200, 2)
    expect(d.rateState).toBe('within_threshold')
    expect(d.domainState).toBe('healthy')
  })

  it('treats zero sends as an undefined rate, not as zero percent', () => {
    const d = evaluateDomain('example.com', 0, 0)
    expect(d.bounceRate).toBeNull()
    expect(d.rateState).toBe('insufficient_sends')
    expect(d.domainState).toBe('insufficient_sends')
  })
})

// ── THE FOUR OVERALL STATES ──────────────────────────────────────────────────
describe('overall state: no_data', () => {
  it('is no_data when there are no rows at all', () => {
    const v = evaluateSendingHealth([], NOW)
    expect(v.state).toBe('no_data')
    expect(v.domains).toEqual([])
    expect(v.detail).toContain('Nothing has been judged')
  })

  it('is no_data when every row falls outside the window', () => {
    // 2026-08-20 is one day before the window start. Silently counting it would inflate
    // denominators and hide breaches.
    const v = evaluateSendingHealth([row('a.com', '2026-08-20', 500, 99)], NOW)
    expect(v.state).toBe('no_data')
  })
})

describe('overall state: insufficient_sends', () => {
  it('is insufficient_sends when no domain clears the floor and nothing breached', () => {
    // This is today's real shape: ~28 sends per domain per week, zero bounces.
    const v = evaluateSendingHealth([
      row('a.com', '2026-08-24', 28, 0),
      row('b.com', '2026-08-24', 24, 0),
    ], NOW)
    expect(v.state).toBe('insufficient_sends')
  })

  it('says in words that the rate rule judged nothing', () => {
    const v = evaluateSendingHealth([row('a.com', '2026-08-24', 28, 0)], NOW)
    expect(v.detail).toContain('judged nothing')
    expect(v.detail).toContain(String(RATE_MINIMUM_SENDS))
  })

  it('is NOT healthy, which is the entire point of the state existing', () => {
    const v = evaluateSendingHealth([row('a.com', '2026-08-24', 28, 0)], NOW)
    expect(v.state).not.toBe('healthy')
  })
})

describe('overall state: healthy', () => {
  it('is healthy once at least one domain was judged by both triggers and passed', () => {
    const v = evaluateSendingHealth([row('a.com', '2026-08-24', 500, 2)], NOW)
    expect(v.state).toBe('healthy')
  })

  it('is healthy when one domain clears the floor even though another does not', () => {
    const v = evaluateSendingHealth([
      row('big.com',   '2026-08-24', 500, 1),
      row('small.com', '2026-08-24', 10,  0),
    ], NOW)
    expect(v.state).toBe('healthy')
  })

  it('still names the domains the rate rule skipped', () => {
    const v = evaluateSendingHealth([
      row('big.com',   '2026-08-24', 500, 1),
      row('small.com', '2026-08-24', 10,  0),
    ], NOW)
    expect(v.detail).toContain('1 of 2 domain(s) sent fewer than')
  })
})

describe('overall state: failing', () => {
  it('is failing when one domain breaches the absolute trigger', () => {
    const v = evaluateSendingHealth([
      row('good.com', '2026-08-24', 500, 1),
      row('bad.com',  '2026-08-24', 30,  ABSOLUTE_BOUNCE_TRIGGER),
    ], NOW)
    expect(v.state).toBe('failing')
  })

  it('is failing when one domain breaches the rate trigger only', () => {
    const v = evaluateSendingHealth([
      row('good.com', '2026-08-24', 500, 1),
      row('bad.com',  '2026-08-24', 50,  2),   // 4%, and under the absolute trigger
    ], NOW)
    expect(v.state).toBe('failing')
  })

  it('names the offending domain with numerator and denominator, never a bare percentage', () => {
    const v = evaluateSendingHealth([row('bad.com', '2026-08-24', 50, 2)], NOW)
    expect(v.detail).toContain('bad.com 2/50')
    expect(v.detail).toContain('4.0%')
  })

  it('a single breaching domain outweighs any number of clean ones', () => {
    const v = evaluateSendingHealth([
      row('c1.com', '2026-08-24', 500, 0),
      row('c2.com', '2026-08-24', 500, 0),
      row('c3.com', '2026-08-24', 500, 0),
      row('bad.com', '2026-08-24', 500, ABSOLUTE_BOUNCE_TRIGGER),
    ], NOW)
    expect(v.state).toBe('failing')
  })
})

// ── Aggregation behaviour ────────────────────────────────────────────────────
describe('aggregation across mailboxes and days', () => {
  it('sums every mailbox and every day within one domain', () => {
    // Two mailboxes on one domain, three days each. This is the shape that makes the
    // per-domain rule different from the per-mailbox data it reads.
    const v = evaluateSendingHealth([
      row('d.com', '2026-08-22', 10, 1),
      row('d.com', '2026-08-22', 10, 0),
      row('d.com', '2026-08-25', 15, 1),
      row('d.com', '2026-08-27', 15, 0),
    ], NOW)
    expect(v.domains).toHaveLength(1)
    expect(v.domains[0].sends).toBe(50)
    expect(v.domains[0].bounces).toBe(2)
  })

  it('keeps domains separate, so one bad domain does not hide behind good ones', () => {
    // Pooled, this is 3 bounces in 1000 = 0.3% and looks fine. Per domain, bad.com is
    // 3 in 50 = 6%. The whole feature exists for this difference.
    const v = evaluateSendingHealth([
      row('good.com', '2026-08-24', 950, 0),
      row('bad.com',  '2026-08-24', 50,  3),
    ], NOW)
    expect(v.state).toBe('failing')
    const bad = v.domains.find(d => d.domain === 'bad.com')!
    expect(bad.bounceRate).toBeCloseTo(0.06, 10)
  })

  it('includes both boundary days of the window', () => {
    const v = evaluateSendingHealth([
      row('d.com', '2026-08-21', 5, 0),   // first day in window
      row('d.com', '2026-08-27', 5, 0),   // last day in window
    ], NOW)
    expect(v.domains[0].sends).toBe(10)
  })

  it('sorts breaching domains first', () => {
    const v = evaluateSendingHealth([
      row('clean.com', '2026-08-24', 500, 0),
      row('bad.com',   '2026-08-24', 500, ABSOLUTE_BOUNCE_TRIGGER),
    ], NOW)
    expect(v.domains[0].domain).toBe('bad.com')
  })

  it('reports the window it actually used', () => {
    const v = evaluateSendingHealth([row('d.com', '2026-08-24', 5, 0)], NOW)
    expect(v.windowStart).toBe('2026-08-21')
    expect(v.windowEnd).toBe('2026-08-27')
  })
})
