// The call-count budget, and the invariant that keeps it consistent with the wall clock.
//
// WHAT THIS GUARDS. Before 2026-08-29 nothing bounded the number of Anthropic calls a
// messaging run could make. The structural worst case is 25 sequential calls; one run on
// 2026-08-19 ran 21 minutes and produced zero variants. The budget stops the run at a slot
// boundary, keeping every variant that has already passed.
//
// The invariant below is the one that actually matters over time. The budget and the
// wall-clock guard are two numbers in two places that only work together: raise the budget
// without raising the guard and the guard fires first, mid-stream, which is precisely the
// arbitrary failure the budget was added to avoid. There is no headroom to raise the guard
// into, because Vercel's ceiling on this plan is 300s and the route declares exactly that.

import { describe, it, expect } from 'vitest'
import {
  MAX_API_CALLS_PER_RUN,
  AGENT_TIMEOUT_MS,
  MEASURED_FIRST_CALL_SECONDS,
  MEASURED_REPAIR_CALL_SECONDS,
  MEASURED_PREFLIGHT_SECONDS,
  UNBOUNDED_WORST_CASE_CALLS,
} from '../messaging-generation-agent'

// PREFLIGHT IS PART OF THE RUN. Leaving it out is what made this file pass while the
// budget it was checking could not actually be spent: 75 + 26 x 6 = 231 < 240 is true, and
// the real total is that plus everything before the first call. Measured 2026-09-20, a run
// granted 7 calls had the guard fire during its 5th.
const projectedSeconds = (calls: number) =>
  MEASURED_PREFLIGHT_SECONDS +
  MEASURED_FIRST_CALL_SECONDS +
  MEASURED_REPAIR_CALL_SECONDS * (calls - 1)

/**
 * The largest call count whose projection fits inside the guard.
 *
 * THE BUDGET IS DERIVED FROM THIS, NOT COMPARED TO IT. The file used to assert the budget
 * fits and that one more does not, which is two hand-checked inequalities agreeing with a
 * number typed somewhere else. That arrangement cannot tell "the budget is right" from
 * "the budget and the model are wrong in the same direction", and the second is what
 * happened. Now the model produces the number and the constant has to match it.
 */
function largestAffordableCallCount(): number {
  let calls = 0
  while (projectedSeconds(calls + 1) * 1000 < AGENT_TIMEOUT_MS) calls++
  return calls
}

describe('messaging run call budget', () => {
  // ONE ASSERTION, NOT TWO INEQUALITIES. Change any cost term or the guard and this says
  // what the budget should now be instead of agreeing with what is written.
  it('the budget IS the largest call count the guard can afford', () => {
    expect(MAX_API_CALLS_PER_RUN).toBe(largestAffordableCallCount())
  })

  it('and that count is 6 at the durations measured on 2026-09-20', () => {
    // Stated so a change to the cost model shows up as a moved number in a diff rather
    // than as a silently different budget.
    expect(largestAffordableCallCount()).toBe(6)
    expect(projectedSeconds(6)).toBe(214)
    expect(projectedSeconds(7)).toBe(240)   // equal to the guard, so not inside it
  })

  it('is actually binding: the structural worst case far exceeds it', () => {
    expect(UNBOUNDED_WORST_CASE_CALLS).toBe(25)
    expect(UNBOUNDED_WORST_CASE_CALLS).toBeGreaterThan(MAX_API_CALLS_PER_RUN)
  })

  it('the guard stays under the Vercel ceiling the route declares', () => {
    // maxDuration = 300 in src/app/api/suggestions/regenerate/route.ts and
    // src/app/api/agents/messaging/route.ts. 300s is the Hobby ceiling, not a setting.
    expect(AGENT_TIMEOUT_MS).toBeLessThan(300 * 1000)
  })

  it('reproduces the measured durations of the two runs that failed on 2026-08-28', () => {
    // Both runs reached 9 completed calls and were killed starting the 10th at 300s.
    expect(projectedSeconds(9)).toBeGreaterThan(AGENT_TIMEOUT_MS / 1000)
    expect(projectedSeconds(9)).toBeLessThan(300)
    // And the budget would have stopped them well before that.
    expect(MAX_API_CALLS_PER_RUN).toBeLessThan(9)
  })
})
