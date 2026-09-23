// The window decision, on its own, with every branch reachable.
//
// planNextWindow is pure and takes elapsed time as a NUMBER rather than reading a clock. That
// is the only reason the budget-exhausted branch is testable at all: the real budget is 240
// seconds, and a test that had to wait for it would not exist.

import { describe, it, expect } from 'vitest'
import {
  planNextWindow,
  describeStop,
  SOURCING_WINDOW_RECORDS,
  SOURCING_WINDOW_SAFETY,
  SOURCING_RUNTIME_BUDGET_MS,
} from '../window-budget'

/** A state with nothing measured yet: the shape the first window is decided from. */
function firstWindow(overrides: Partial<Parameters<typeof planNextWindow>[0]> = {}) {
  return {
    targetBatchSize: 500,
    recordsConsumed: 0,
    elapsedMs: 0,
    budgetMs: SOURCING_RUNTIME_BUDGET_MS,
    lastWindowMs: null,
    lastWindowRecords: null,
    lastWindowRequested: null,
    ceilingReached: false,
    resultSetExhausted: false,
    ...overrides,
  }
}

/** A state after one window of 100 that took `ms`. */
function afterWindow(ms: number, overrides: Partial<Parameters<typeof planNextWindow>[0]> = {}) {
  return firstWindow({
    recordsConsumed: 100,
    elapsedMs: ms,
    lastWindowMs: ms,
    lastWindowRecords: 100,
    lastWindowRequested: 100,
    ...overrides,
  })
}

describe('planNextWindow: the constants', () => {
  it('sizes a window at one provider page, so a window costs exactly one provider call', () => {
    // The Apollo handler sets per_page = min(cap, 100). A window of 100 is therefore page
    // aligned: one request, and nothing discarded from the front of the first page. A window
    // of anything else would either split a page or leave a skipInPage remainder.
    expect(SOURCING_WINDOW_RECORDS).toBe(100)
  })

  it('leaves the route 60 seconds of its 300 for cold start, auth and a slow tail', () => {
    expect(SOURCING_RUNTIME_BUDGET_MS).toBe(240_000)
  })
})

describe('planNextWindow: the first window always runs', () => {
  it('proceeds with nothing measured, because the rate is measured FROM this window', () => {
    const d = planNextWindow(firstWindow())
    expect(d.proceed).toBe(true)
    expect(d.windowRecords).toBe(100)
    // No prediction is possible yet, and saying so beats reporting a made-up number.
    expect(d.predictedMs).toBeNull()
  })

  it('proceeds even when the budget is already almost gone', () => {
    // Today's code attempts the WHOLE batch with no time check at all, so refusing the very
    // first window would be a regression against the behaviour being replaced. This is the
    // assertion that pins that reasoning.
    const d = planNextWindow(firstWindow({ elapsedMs: 239_000 }))
    expect(d.proceed).toBe(true)
  })

  it('never asks for more than the operator requested', () => {
    const d = planNextWindow(firstWindow({ targetBatchSize: 30 }))
    expect(d.windowRecords).toBe(30)
  })
})

describe('planNextWindow: stopping', () => {
  it('stops at target_met once the requested records are consumed', () => {
    const d = planNextWindow(afterWindow(5_000, { targetBatchSize: 100 }))
    expect(d).toMatchObject({ proceed: false, stop: 'target_met', windowRecords: 0 })
  })

  it('stops at ceiling_reached before anything else, because another press cannot help', () => {
    // Checked first on purpose. A run at the ceiling has also usually met neither its target
    // nor its budget, and reporting either of those would tell the operator to press again.
    const d = planNextWindow(afterWindow(5_000, { ceilingReached: true }))
    expect(d.stop).toBe('ceiling_reached')
  })

  it('stops at provider_exhausted when a window returned fewer records than it asked for', () => {
    // The handler shortens a window only when the result set has run out: it breaks when the
    // records read reach the provider's reported total, or when a page is shorter than
    // per_page. So a short window means there is no more, and another provider call would buy
    // the same answer.
    const d = planNextWindow(afterWindow(5_000, {
      recordsConsumed: 40,
      lastWindowRecords: 40,
      lastWindowRequested: 100,
    }))
    expect(d.stop).toBe('provider_exhausted')
  })

  it('stops at provider_exhausted on a window that returned nothing, rather than dividing by zero', () => {
    // The per-record rate is lastWindowMs / lastWindowRecords. A zero-record window would make
    // that Infinity, and the guard above is what keeps the arithmetic below from seeing it.
    const d = planNextWindow(afterWindow(5_000, {
      recordsConsumed: 0,
      lastWindowRecords: 0,
      lastWindowRequested: 100,
    }))
    expect(d.stop).toBe('provider_exhausted')
    expect(d.predictedMs).toBeNull()
  })

  it('stops at budget_exhausted when the next window would not fit', () => {
    // The real slow run: 2026-09-15, 44 candidates in 155,521 ms, about 3,535 ms each. Scaled
    // to a 100-record window that is ~150s of a 240s budget for ONE window, and the next one
    // predicts 150s x 1.5 = 225s against 90s left.
    const d = planNextWindow(afterWindow(150_000))
    expect(d).toMatchObject({ proceed: false, stop: 'budget_exhausted' })
    expect(d.predictedMs).toBe(150_000 * SOURCING_WINDOW_SAFETY)
  })

  it('keeps going on a fast run, which is what makes one press enough for 500', () => {
    // The fast end of the measured range: 2026-09-21, 200 candidates in 11,630 ms, about 58 ms
    // each, so a 100-record window is ~5.8s. Five windows of that fit in the budget many times
    // over, which is the whole point of not stopping after the first.
    let state = afterWindow(5_800)
    let windows = 1
    while (windows < 20) {
      const d = planNextWindow(state)
      if (!d.proceed) {
        expect(d.stop).toBe('target_met')
        break
      }
      windows++
      state = {
        ...state,
        recordsConsumed: state.recordsConsumed + d.windowRecords,
        elapsedMs: state.elapsedMs + 5_800,
        lastWindowMs: 5_800,
        lastWindowRecords: d.windowRecords,
        lastWindowRequested: d.windowRecords,
      }
    }
    // 500 records at 100 a window is five windows, and all five fit.
    expect(windows).toBe(5)
    expect(state.recordsConsumed).toBe(500)
  })

  it('applies the safety margin, so a window that only just fits is refused', () => {
    // 100s elapsed, 100s for the last window, 240s budget. Without the margin the prediction
    // is 100s and 200s <= 240s proceeds. With it the prediction is 150s and 250s does not.
    // This is the assertion that fails if SOURCING_WINDOW_SAFETY is dropped to 1.
    const d = planNextWindow(afterWindow(100_000))
    expect(SOURCING_WINDOW_SAFETY).toBeGreaterThan(1)
    expect(d.stop).toBe('budget_exhausted')

    // And the unmargined version really would have proceeded, which is what makes the
    // assertion above about the margin rather than about the numbers.
    const withoutMargin = 100_000 + 100_000
    expect(withoutMargin).toBeLessThanOrEqual(240_000)
  })
})

describe('describeStop: the sentence the operator reads', () => {
  it('names how many remain and that the position is saved, when time ran out', () => {
    const msg = describeStop('budget_exhausted', 100, 500)
    expect(msg).toContain('100 of 500')
    expect(msg).toContain('400 remain')
    // THE PART THAT STOPS THE BABYSITTING. Without it the operator cannot tell a run that
    // stopped early from one that will start over on the next press.
    expect(msg).toMatch(/picks up exactly where this run stopped/)
  })

  it('tells the operator that pressing again will NOT help when the provider has run out', () => {
    // The distinction that matters against budget_exhausted, where another press is exactly
    // the right advice. A bare "not /press again/" assertion was wrong here: this message DOES
    // mention pressing again, in order to say it will not find anyone.
    const msg = describeStop('provider_exhausted', 120, 500)
    expect(msg).toContain('no more people')
    expect(msg).toContain('will not find any')
    expect(msg).not.toMatch(/picks up exactly where/)
  })

  it('says the ICP must change at the record ceiling', () => {
    expect(describeStop('ceiling_reached', 50_000, 500)).toContain('filter spec has to change')
  })

  it('says nothing about remainders when the batch completed', () => {
    const msg = describeStop('target_met', 500, 500)
    expect(msg).toContain('full batch of 500')
    expect(msg).not.toContain('remain')
  })
})
