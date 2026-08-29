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
  UNBOUNDED_WORST_CASE_CALLS,
} from '../messaging-generation-agent'

const projectedSeconds = (calls: number) =>
  MEASURED_FIRST_CALL_SECONDS + MEASURED_REPAIR_CALL_SECONDS * (calls - 1)

describe('messaging run call budget', () => {
  it('the full budget completes inside the wall-clock guard', () => {
    expect(projectedSeconds(MAX_API_CALLS_PER_RUN) * 1000).toBeLessThan(AGENT_TIMEOUT_MS)
  })

  it('one more call than the budget would NOT complete inside the guard', () => {
    // This is what makes MAX_API_CALLS_PER_RUN the largest safe value rather than an
    // arbitrary one. If this fails, the budget has been left below what the clock allows.
    expect(projectedSeconds(MAX_API_CALLS_PER_RUN + 1) * 1000).toBeGreaterThan(AGENT_TIMEOUT_MS)
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
