// THE PACER, MEASURED RATHER THAN ASSERTED.
//
// Every test here drives the real pacer with a fake clock that records what it was asked to
// wait for, then computes the achieved rate from those waits. That is deliberate: the claim
// being made is "this holds a rate", and a test that only checked the interval arithmetic
// would prove the constant and not the behaviour.
//
// The test that matters most is the slow-probe one. A pacer that sleeps a fixed duration
// between calls under-runs the limit; a pacer that chases a fixed average OVER-runs it in a
// burst the moment anything is slow. Both are wrong, in opposite directions, and only a
// measurement across a moving window separates the correct one from the second.

import { describe, it, expect } from 'vitest'
import {
  createPacer,
  pacedIntervalMs,
  probesWithinBudget,
  runBudgetMs,
  PACING_SAFETY_FRACTION,
  DEFAULT_RUN_BUDGET_MS,
  OVERLAP_MARGIN_MS,
  type PacingClock,
} from '../verification-pacing'

/**
 * A clock the test drives by hand.
 *
 * `sleep` does not wait; it advances the clock. So a whole run's worth of pacing is measured
 * in microseconds of real time, and the measurement is exact rather than subject to timer
 * jitter. `advance` is how a test models a probe taking time.
 */
function fakeClock(startAt = 0) {
  let t = startAt
  const slept: number[] = []
  const clock: PacingClock = {
    now: () => t,
    sleep: async (ms: number) => { slept.push(ms); t += ms },
  }
  return {
    clock,
    slept,
    now: () => t,
    /** Model work that takes time: a probe, a database write. */
    advance: (ms: number) => { t += ms },
  }
}

describe('pacedIntervalMs', () => {
  it('targets the safety fraction of the configured limit', () => {
    // 30/min * 0.9 = 27/min = one probe every 2222.2ms.
    expect(pacedIntervalMs(30)).toBe(Math.ceil(60_000 / (30 * PACING_SAFETY_FRACTION)))
    expect(pacedIntervalMs(30)).toBe(2223)
  })

  // ROUNDING UP IS THE WHOLE POINT. Rounding down would put the achieved rate fractionally
  // above the target, and the only direction this number may be wrong in is slow.
  it('rounds up, so the achieved rate is never above the target', () => {
    const limit = 7 // 60000 / 6.3 = 9523.8..., a deliberately non-integer interval
    const interval = pacedIntervalMs(limit)
    expect(Number.isInteger(interval)).toBe(true)
    expect(60_000 / interval).toBeLessThanOrEqual(limit * PACING_SAFETY_FRACTION)
  })

  // The headroom has to survive the limit being raised, which is the reason the limit is
  // configuration at all. A subtraction would leave one call of headroom at a limit of 300.
  it('scales the headroom with the limit rather than leaving a fixed gap', () => {
    for (const limit of [30, 60, 300]) {
      const achieved = 60_000 / pacedIntervalMs(limit)
      expect(achieved).toBeLessThan(limit)
      expect(limit - achieved).toBeGreaterThanOrEqual(limit * (1 - PACING_SAFETY_FRACTION) - 0.01)
    }
  })

  it('refuses a limit that is not a positive number rather than dividing by it', () => {
    expect(() => pacedIntervalMs(0)).toThrow()
    expect(() => pacedIntervalMs(-5)).toThrow()
    expect(() => pacedIntervalMs(Number.NaN)).toThrow()
  })
})

describe('probesWithinBudget', () => {
  // The first probe costs no wait, so a window of exactly one interval holds two.
  it('counts the free first probe', () => {
    expect(probesWithinBudget(0, 1000)).toBe(0)
    expect(probesWithinBudget(1, 1000)).toBe(1)
    expect(probesWithinBudget(1000, 1000)).toBe(2)
    expect(probesWithinBudget(2000, 1000)).toBe(3)
  })

  it('gives the production window its full count', () => {
    // 240s at 2223ms = 107 waits plus the free first probe.
    expect(probesWithinBudget(DEFAULT_RUN_BUDGET_MS, pacedIntervalMs(30))).toBe(108)
  })

  it('is zero for a window that has already closed', () => {
    expect(probesWithinBudget(-5_000, 1000)).toBe(0)
  })
})

describe('runBudgetMs — the ceiling that keeps two runs from overlapping', () => {
  it('uses the compiled budget when the period cannot be read', () => {
    expect(runBudgetMs(null)).toBe(DEFAULT_RUN_BUDGET_MS)
  })

  // At every ten minutes the request cap binds, not the period: 240s of work inside a
  // 600s period leaves 360s of margin.
  it('is bound by the request cap on the live ten-minute schedule', () => {
    expect(runBudgetMs(10 * 60_000)).toBe(DEFAULT_RUN_BUDGET_MS)
  })

  // THE PROPERTY THAT MAKES MOVING THE CRON SAFE. At a five-minute period the period binds
  // instead, automatically, with no code change.
  it('shrinks to fit a shorter period, leaving the overlap margin', () => {
    expect(runBudgetMs(5 * 60_000)).toBe(5 * 60_000 - OVERLAP_MARGIN_MS)
  })

  it('never returns a negative window for a period shorter than the margin', () => {
    expect(runBudgetMs(30_000)).toBe(0)
  })

  // The invariant, stated directly: a run always finishes before the next firing.
  it('always leaves at least the overlap margin before the next firing', () => {
    for (const periodMinutes of [1, 2, 5, 10, 15, 30]) {
      const periodMs = periodMinutes * 60_000
      expect(runBudgetMs(periodMs)).toBeLessThanOrEqual(Math.max(0, periodMs - OVERLAP_MARGIN_MS))
    }
  })
})

describe('createPacer — the rate it actually holds', () => {
  it('lets the first probe start immediately', async () => {
    const { clock, slept } = fakeClock(1_000)
    const pacer = createPacer(2223, clock)

    const slot = await pacer.awaitSlot()

    expect(slot).toBe(1_000)
    expect(slept).toEqual([])
  })

  // The core claim: with instant probes, the achieved rate is the target rate.
  it('holds the target rate when probes are instant', async () => {
    const { clock, now } = fakeClock()
    const interval = pacedIntervalMs(30)
    const pacer = createPacer(interval, clock)

    const starts: number[] = []
    for (let i = 0; i < 30; i++) starts.push(await pacer.awaitSlot())

    const elapsedMs = now()
    const achievedPerMinute = (starts.length - 1) * 60_000 / elapsedMs

    expect(achievedPerMinute).toBeLessThan(30)
    expect(achievedPerMinute).toBeCloseTo(27, 1)
  })

  // ── THE ONE THAT SEPARATES A CORRECT PACER FROM A PLAUSIBLE ONE ─────────────
  //
  // A probe that takes 600ms used to be followed by a flat 2000ms sleep, making the real
  // cycle 2600ms: 23 a minute against a limit of 30. The slower the provider, the further
  // under the limit it drifted, which is exactly backwards.
  it('absorbs probe time into the interval instead of adding to it', async () => {
    const probeMs = 600
    const { clock, now, advance } = fakeClock()
    const interval = pacedIntervalMs(30)
    const pacer = createPacer(interval, clock)

    const starts: number[] = []
    for (let i = 0; i < 30; i++) {
      starts.push(await pacer.awaitSlot())
      advance(probeMs) // the probe itself
    }

    // Measured start-to-start, not including the trailing probe.
    const spanMs = starts[starts.length - 1] - starts[0]
    const achievedPerMinute = (starts.length - 1) * 60_000 / spanMs

    expect(achievedPerMinute).toBeCloseTo(27, 1)

    // What the old flat sleep would have achieved, stated so the improvement is a number
    // rather than a claim.
    const flatSleepRate = 60_000 / (2_000 + probeMs)
    expect(flatSleepRate).toBeLessThan(24)
    expect(achievedPerMinute).toBeGreaterThan(flatSleepRate)
  })

  // ── NO CATCH-UP BURST ───────────────────────────────────────────────────────
  //
  // When a probe overruns its entire slot, a pacer chasing a target AVERAGE would fire the
  // missed slots back to back to recover. That is a rate-limit breach however good the
  // average looks, because a per-minute limit measures a window and not a mean.
  it('does not fire a backlog of missed slots after a slow probe', async () => {
    const { clock, advance, slept } = fakeClock()
    const interval = 2223
    const pacer = createPacer(interval, clock)

    await pacer.awaitSlot()
    advance(interval * 5) // one very slow probe, five slots' worth

    const resumed = await pacer.awaitSlot()
    const afterResume = await pacer.awaitSlot()

    // The slot after the overrun is immediate (its time has passed), and the one after THAT
    // is a full interval later. Nothing is fired back to back to make up the average.
    expect(afterResume - resumed).toBe(interval)
    expect(slept.filter(ms => ms > 0)).toEqual([interval])
  })

  // The same property, stated as the thing a provider would actually measure: no 60-second
  // window anywhere in the run contains more probes than the limit allows.
  it('keeps every sliding 60-second window under the configured limit, even with erratic probes', async () => {
    const limit = 30
    const { clock, advance } = fakeClock()
    const pacer = createPacer(pacedIntervalMs(limit), clock)

    // A deliberately uneven provider: mostly fast, occasionally far slower than a slot.
    const probeDurations = [50, 80, 12_000, 40, 60, 9_000, 30, 45, 70, 15_000, 25, 35]

    const starts: number[] = []
    for (let i = 0; i < 120; i++) {
      starts.push(await pacer.awaitSlot())
      advance(probeDurations[i % probeDurations.length])
    }

    for (const windowStart of starts) {
      const inWindow = starts.filter(t => t >= windowStart && t < windowStart + 60_000).length
      expect(inWindow).toBeLessThanOrEqual(limit)
    }
  })

  it('reports the next slot without consuming it', async () => {
    const { clock } = fakeClock(5_000)
    const pacer = createPacer(2223, clock)

    expect(pacer.nextSlotAt()).toBe(5_000)
    expect(pacer.nextSlotAt()).toBe(5_000) // asking twice does not advance anything

    await pacer.awaitSlot()
    expect(pacer.nextSlotAt()).toBe(5_000 + 2223)
  })

  it('refuses a non-positive interval', () => {
    expect(() => createPacer(0)).toThrow()
    expect(() => createPacer(-1)).toThrow()
  })
})
