// THE ESTIMATES BEHIND "when does this finish" AND "how many more presses".
//
// The tests that matter most here are the ones about REFUSING to answer. Both functions feed
// text on an operator screen, and a confident number built on an input that could not be read
// is worse than a blank line: it gets planned around.

import { describe, it, expect } from 'vitest'
import {
  estimateVerificationDrainMinutes,
  planEnrichmentPresses,
  describeMinutes,
} from '../stage-estimates'
import {
  pacedIntervalMs,
  probesWithinBudget,
  runBudgetMs,
} from '@/lib/sourcing/verification-pacing'

/** The live shape on 2026-09-21: every ten minutes, 30 a minute allowed. */
const TEN_MINUTES = 10 * 60_000
const LIVE = { periodMs: TEN_MINUTES, ratePerMinute: 30 }

/** What one run of the live configuration can actually probe. */
const PER_RUN = probesWithinBudget(runBudgetMs(TEN_MINUTES), pacedIntervalMs(30))

describe('estimateVerificationDrainMinutes', () => {
  it('is zero when nothing is waiting', () => {
    expect(estimateVerificationDrainMinutes({ ...LIVE, waiting: 0, msUntilNextRun: 60_000 })).toBe(0)
  })

  // ── WHY NOT waiting / ratePerMinute ─────────────────────────────────────────
  //
  // That is the answer if the sweep ran continuously. It does not: it works for a budget and
  // then waits for the next firing. The estimate has to include the gaps, or it is wrong by
  // most of the elapsed time on any backlog needing more than one run.
  it('counts the gaps between runs, not just the probing time', () => {
    const waiting = PER_RUN * 3 // three full runs
    const minutes = estimateVerificationDrainMinutes({
      ...LIVE,
      waiting,
      msUntilNextRun: 0,
    })

    // Naive: 324 addresses at 27 a minute would be 12 minutes.
    const naive = waiting / (30 * 0.9)
    expect(naive).toBeLessThan(13)

    // Real: two whole periods plus the final run's probing. Far more than the naive answer.
    expect(minutes).toBeGreaterThan(20)
    expect(minutes).toBeLessThan(35)
  })

  // A FULL RUN'S WORTH, deliberately, so neither answer lands on the one-minute floor.
  // Compared at `waiting: 10` these differ by 7 rather than 8, because the sooner estimate
  // rounds to 20 seconds and is then raised to the floor: an estimate of "0 minutes" beside
  // work still to do would read as finished. That floor is correct and it makes small
  // backlogs the wrong place to measure a difference.
  it('includes the wait for the first run', () => {
    const soon = estimateVerificationDrainMinutes({
      ...LIVE, waiting: PER_RUN, msUntilNextRun: 0,
    })
    const later = estimateVerificationDrainMinutes({
      ...LIVE, waiting: PER_RUN, msUntilNextRun: 8 * 60_000,
    })
    expect(soon).not.toBeNull()
    expect(later).not.toBeNull()
    expect((later as number) - (soon as number)).toBe(8)
  })

  // The floor itself, stated directly rather than left as a surprise in the test above.
  it('never reports zero minutes while work is still waiting', () => {
    expect(estimateVerificationDrainMinutes({ ...LIVE, waiting: 1, msUntilNextRun: 0 })).toBe(1)
  })

  // A backlog of 3 finishing in the next run must not report a whole budget's worth of time.
  it('charges the final run only for what it actually probes', () => {
    const tiny = estimateVerificationDrainMinutes({ ...LIVE, waiting: 3, msUntilNextRun: 60_000 })
    expect(tiny).toBe(1)
  })

  it('grows a whole period for each additional run needed', () => {
    const oneRun = estimateVerificationDrainMinutes({
      ...LIVE, waiting: PER_RUN, msUntilNextRun: 0,
    })
    const twoRuns = estimateVerificationDrainMinutes({
      ...LIVE, waiting: PER_RUN + 1, msUntilNextRun: 0,
    })
    expect(oneRun).not.toBeNull()
    expect(twoRuns).not.toBeNull()
    expect(twoRuns as number).toBeGreaterThan(oneRun as number)
  })

  // A faster configured pace clears the same backlog in fewer runs, which is the whole point
  // of the limit being configuration.
  it('shortens when the configured pace is raised', () => {
    const atThirty = estimateVerificationDrainMinutes({
      periodMs: TEN_MINUTES, ratePerMinute: 30, waiting: 400, msUntilNextRun: 0,
    })
    const atOneTwenty = estimateVerificationDrainMinutes({
      periodMs: TEN_MINUTES, ratePerMinute: 120, waiting: 400, msUntilNextRun: 0,
    })
    expect(atOneTwenty as number).toBeLessThan(atThirty as number)
  })

  describe('refuses to answer rather than guessing', () => {
    it('returns null without a period', () => {
      expect(estimateVerificationDrainMinutes({
        periodMs: null, ratePerMinute: 30, waiting: 50, msUntilNextRun: 60_000,
      })).toBeNull()
    })

    it('returns null without a next-run time', () => {
      expect(estimateVerificationDrainMinutes({
        periodMs: TEN_MINUTES, ratePerMinute: 30, waiting: 50, msUntilNextRun: null,
      })).toBeNull()
    })

    it('returns null for a nonsense rate rather than dividing by it', () => {
      for (const rate of [0, -1, Number.NaN]) {
        expect(estimateVerificationDrainMinutes({
          periodMs: TEN_MINUTES, ratePerMinute: rate, waiting: 50, msUntilNextRun: 0,
        })).toBeNull()
      }
    })
  })
})

describe('planEnrichmentPresses', () => {
  // TWO CEILINGS, AND THEY ARE DIFFERENT THINGS. perPassLimit (100) is one call to the
  // enrichment trigger. maxPerPress (500) is what one press of the button gets through, because
  // a press now makes as many passes as its time budget allows. pressesNeeded counts PRESSES and
  // therefore divides by the second, not the first.
  //
  // THIS TEST USED TO ASSERT 3 PRESSES FOR 240 WAITING. That was right when a press was one
  // pass; it is now one press, and asserting the old number would pin the screen to a promise
  // the button stopped making.
  it('reports ONE press for a 240 backlog, because a press continues by itself', () => {
    expect(planEnrichmentPresses(240, 100, 500)).toEqual({
      thisPress: 240,
      remainingAfter: 0,
      pressesNeeded: 1,
      // Three passes of up to 100 inside that one press. Reported so the screen can explain
      // why the press takes a while rather than leaving it looking stuck.
      passesThisPress: 3,
    })
  })

  it('reports a single press and a single pass when the backlog is small', () => {
    expect(planEnrichmentPresses(40, 100, 500)).toEqual({
      thisPress: 40,
      remainingAfter: 0,
      pressesNeeded: 1,
      passesThisPress: 1,
    })
  })

  it('reports exactly one press at the per-press ceiling, not two', () => {
    expect(planEnrichmentPresses(500, 100, 500)).toEqual({
      thisPress: 500,
      remainingAfter: 0,
      pressesNeeded: 1,
      passesThisPress: 5,
    })
  })

  it('still says another press is needed above the per-press ceiling', () => {
    // The case auto-continue does NOT remove, and the one the screen must still report.
    expect(planEnrichmentPresses(501, 100, 500)).toMatchObject({
      thisPress: 500,
      remainingAfter: 1,
      pressesNeeded: 2,
    })
  })

  it('rounds a part-press up', () => {
    expect(planEnrichmentPresses(1001, 100, 500)?.pressesNeeded).toBe(3)
  })

  it('is null when nothing is waiting, so the screen gains no line', () => {
    expect(planEnrichmentPresses(0, 100, 500)).toBeNull()
    expect(planEnrichmentPresses(-3, 100, 500)).toBeNull()
  })

  it('is null for a nonsense ceiling rather than dividing by it', () => {
    expect(planEnrichmentPresses(50, 0, 500)).toBeNull()
    expect(planEnrichmentPresses(50, Number.NaN, 500)).toBeNull()
    // BOTH of them, because either one divided by is a division by zero or NaN.
    expect(planEnrichmentPresses(50, 100, 0)).toBeNull()
    expect(planEnrichmentPresses(50, 100, Number.NaN)).toBeNull()
  })

  // Both ceilings are parameters, so the screen and the route read one number each. A hard-coded
  // 100 or 500 in here would be the second copy this shape exists to remove.
  it('follows the ceilings it is given', () => {
    expect(planEnrichmentPresses(1200, 100, 250)?.pressesNeeded).toBe(5)
    expect(planEnrichmentPresses(1200, 100, 2000)?.pressesNeeded).toBe(1)
    expect(planEnrichmentPresses(1200, 50, 2000)?.passesThisPress).toBe(24)
  })
})

describe('describeMinutes', () => {
  it('reads as plain English at every scale', () => {
    expect(describeMinutes(0)).toBe('under a minute')
    expect(describeMinutes(1)).toBe('about a minute')
    expect(describeMinutes(12)).toBe('about 12 minutes')
    expect(describeMinutes(59)).toBe('about 59 minutes')
    expect(describeMinutes(75)).toBe('about an hour and a half')
    expect(describeMinutes(180)).toBe('about 3 hours')
    expect(describeMinutes(60 * 30)).toBe('about a day')
    expect(describeMinutes(60 * 24 * 3)).toBe('about 3 days')
  })

  // The inputs are a cron period and a rate limit. Neither supports minute precision on a
  // three-hour answer, and printing one would claim a resolution the estimate does not have.
  it('stops claiming minute precision above an hour', () => {
    expect(describeMinutes(187)).not.toContain('187')
  })

  it('is null for a missing or impossible value', () => {
    expect(describeMinutes(null)).toBeNull()
    expect(describeMinutes(-1)).toBeNull()
    expect(describeMinutes(Number.NaN)).toBeNull()
  })
})
