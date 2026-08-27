import { describe, it, expect } from 'vitest'
import { resolveMonitorState } from '../monitor-state'
import { VERDICT_MAX_AGE_MINUTES } from '../thresholds'

/**
 * The staleness guard is a TESTED BEHAVIOUR, not a comment.
 *
 * A stored verdict is only worth reporting while it is recent. If the cron that writes it
 * stops, the last verdict sits there saying "healthy" forever, and a monitor reading green
 * because its input stopped arriving is the same defect as one reading green because it
 * had nothing to judge. Both directions of the boundary are tested so the age limit cannot
 * be moved without breaking something.
 */

const NOW = new Date('2026-08-27T12:00:00.000Z')

function minutesAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 60_000)
}

describe('MON-023 state: no_data', () => {
  it('is UNKNOWN before any verdict has ever been written', () => {
    const r = resolveMonitorState({ storedState: null, computedAt: null, now: NOW })
    expect(r.state).toBe('UNKNOWN')
    expect(r.healthState).toBe('no_data')
  })

  it('is UNKNOWN when a computedAt exists but the state does not', () => {
    const r = resolveMonitorState({ storedState: null, computedAt: minutesAgo(1), now: NOW })
    expect(r.state).toBe('UNKNOWN')
    expect(r.healthState).toBe('no_data')
  })

  it('distinguishes a FRESH no_data verdict from never having run', () => {
    // The fetch ran, looked at the window, and found nothing. Not a pass.
    const r = resolveMonitorState({
      storedState: 'no_data', computedAt: minutesAgo(1), storedDetail: 'No rows.', now: NOW,
    })
    expect(r.state).toBe('UNKNOWN')
    expect(r.healthState).toBe('no_data')
    expect(r.detail).toBe('No rows.')
  })

  it('explains that no_data is expected right after deploy', () => {
    const r = resolveMonitorState({ storedState: null, computedAt: null, now: NOW })
    expect(r.detail).toContain('first instantly-poll run after deploy')
  })
})

describe('MON-023 state: stale', () => {
  it(`is still FRESH at exactly ${VERDICT_MAX_AGE_MINUTES} minutes`, () => {
    const r = resolveMonitorState({
      storedState: 'healthy', computedAt: minutesAgo(VERDICT_MAX_AGE_MINUTES), now: NOW,
    })
    expect(r.healthState).toBe('healthy')
    expect(r.state).toBe('OK')
  })

  it(`is STALE one minute past ${VERDICT_MAX_AGE_MINUTES}`, () => {
    const r = resolveMonitorState({
      storedState: 'healthy', computedAt: minutesAgo(VERDICT_MAX_AGE_MINUTES + 1), now: NOW,
    })
    expect(r.healthState).toBe('stale')
    expect(r.state).toBe('PROBLEM')
  })

  it('a stale HEALTHY verdict alerts rather than reading green', () => {
    // The exact failure the guard exists for.
    const r = resolveMonitorState({
      storedState: 'healthy', computedAt: minutesAgo(60 * 24), now: NOW,
    })
    expect(r.state).toBe('PROBLEM')
    expect(r.healthState).not.toBe('healthy')
  })

  it('staleness outranks the stored verdict, including a failing one', () => {
    const r = resolveMonitorState({
      storedState: 'failing', computedAt: minutesAgo(60 * 24), now: NOW,
    })
    expect(r.state).toBe('PROBLEM')
    expect(r.healthState).toBe('stale')
  })

  it('says how old the verdict is, what it said, and where to look', () => {
    const r = resolveMonitorState({
      storedState: 'healthy', computedAt: minutesAgo(120), now: NOW,
    })
    expect(r.detail).toContain('120 minutes old')
    expect(r.detail).toContain('healthy')
    expect(r.detail).toContain('instantly-poll')
  })

  it('a stale insufficient_sends verdict is also PROBLEM', () => {
    const r = resolveMonitorState({
      storedState: 'insufficient_sends', computedAt: minutesAgo(VERDICT_MAX_AGE_MINUTES + 1), now: NOW,
    })
    expect(r.state).toBe('PROBLEM')
    expect(r.healthState).toBe('stale')
  })
})

describe('MON-023 state: failing', () => {
  it('is PROBLEM when a fresh verdict says failing', () => {
    const r = resolveMonitorState({
      storedState: 'failing', computedAt: minutesAgo(2), storedDetail: 'bad.com 3/50 (6.0%)', now: NOW,
    })
    expect(r.state).toBe('PROBLEM')
    expect(r.healthState).toBe('failing')
  })

  it('passes the stored detail through, so the operator sees which domain', () => {
    const r = resolveMonitorState({
      storedState: 'failing', computedAt: minutesAgo(2), storedDetail: 'bad.com 3/50 (6.0%)', now: NOW,
    })
    expect(r.detail).toBe('bad.com 3/50 (6.0%)')
  })
})

describe('MON-023 state: insufficient_sends', () => {
  it('is OK to the sweep, so the check is not born dark', () => {
    // Mapping this to UNKNOWN would mean the sweep never records an event (it treats "no
    // prior event" as UNKNOWN and only writes on a change), leaving MON-023 silent and
    // indistinguishable from MON-008.
    const r = resolveMonitorState({
      storedState: 'insufficient_sends', computedAt: minutesAgo(2), now: NOW,
    })
    expect(r.state).toBe('OK')
  })

  it('stays distinguishable from healthy in healthState', () => {
    const r = resolveMonitorState({
      storedState: 'insufficient_sends', computedAt: minutesAgo(2), now: NOW,
    })
    expect(r.healthState).toBe('insufficient_sends')
    expect(r.healthState).not.toBe('healthy')
  })
})

describe('MON-023 state: healthy', () => {
  it('is OK when a fresh verdict says healthy', () => {
    const r = resolveMonitorState({
      storedState: 'healthy', computedAt: minutesAgo(2), storedDetail: 'All 5 domain(s) within threshold.', now: NOW,
    })
    expect(r.state).toBe('OK')
    expect(r.healthState).toBe('healthy')
    expect(r.detail).toBe('All 5 domain(s) within threshold.')
  })

  it('falls back to a readable detail when none was stored', () => {
    const r = resolveMonitorState({ storedState: 'healthy', computedAt: minutesAgo(2), now: NOW })
    expect(r.detail).toContain('healthy')
  })
})

describe('the four states are all reachable and all distinct', () => {
  it('produces four distinct healthState values plus no_data', () => {
    const fresh = minutesAgo(2)
    const seen = new Set([
      resolveMonitorState({ storedState: 'healthy',            computedAt: fresh,        now: NOW }).healthState,
      resolveMonitorState({ storedState: 'insufficient_sends', computedAt: fresh,        now: NOW }).healthState,
      resolveMonitorState({ storedState: 'failing',            computedAt: fresh,        now: NOW }).healthState,
      resolveMonitorState({ storedState: 'healthy',            computedAt: minutesAgo(999), now: NOW }).healthState,
      resolveMonitorState({ storedState: null,                 computedAt: null,         now: NOW }).healthState,
    ])
    expect(seen).toEqual(new Set(['healthy', 'insufficient_sends', 'failing', 'stale', 'no_data']))
  })
})

describe('the freshness constant is pinned to a literal', () => {
  // Same hole as the bounce triggers: every boundary test above reads
  // VERDICT_MAX_AGE_MINUTES and therefore moves with it. Pinned so widening the window,
  // the direction that makes the monitor blind, cannot be free.
  it('is 60 minutes, which is four missed 15-minute runs', () => {
    expect(VERDICT_MAX_AGE_MINUTES).toBe(60)
    expect(resolveMonitorState({ storedState: 'healthy', computedAt: minutesAgo(61), now: NOW }).healthState).toBe('stale')
    expect(resolveMonitorState({ storedState: 'healthy', computedAt: minutesAgo(59), now: NOW }).healthState).toBe('healthy')
  })
})
