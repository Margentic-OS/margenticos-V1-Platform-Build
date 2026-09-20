// REPAIRS ARE BREADTH-FIRST: every failing slot gets its first repair before any slot
// gets its second.
//
// WHAT THIS GUARDS. Depth-first ran one slot through its whole hierarchy before touching
// the next. Measured on the run of 2026-09-20: all four variants failed the first pass,
// variant A was repaired in ONE attempt, variant B then consumed FIVE, and C and D were
// never attempted. Four slots each needing one correction cost four calls; one slot
// needing six costs six and leaves nothing for the other three.
//
// The budget is not changed by any of this. Only the order it is spent in.
//
// The scheduler takes `attempt` and `hasBudget` as parameters precisely so the ORDER can
// be tested without a network, an API key or a model. Every test here drives the real
// scheduler with a fake attempt that records the order it was called in.

import { describe, it, expect } from 'vitest'
import {
  scheduleRepairsBreadthFirst,
  repairStepCount,
  MAX_API_CALLS_PER_RUN,
} from '../messaging-generation-agent'

const SLOTS = ['A', 'B', 'C', 'D']

/** Records every (slot, step) pair in the order the scheduler asked for it. */
function recorder(settleOn: (slot: string, step: number) => boolean) {
  const order: string[] = []
  return {
    order,
    attempt: async (slot: string, step: number) => {
      order.push(`${slot}${step + 1}`)
      return settleOn(slot, step)
    },
  }
}

describe('four slots that all fail their first repair', () => {
  // THE CASE THAT MOTIVATED THE CHANGE.
  const run = async () => {
    const r = recorder(() => false)
    await scheduleRepairsBreadthFirst({
      slots: SLOTS, stepsPerSlot: 2, hasBudget: () => true, attempt: r.attempt,
    })
    return r.order
  }

  it('gives every slot its first repair before any slot gets a second', async () => {
    expect(await run()).toEqual(['A1', 'B1', 'C1', 'D1', 'A2', 'B2', 'C2', 'D2'])
  })

  it('the first four attempts are four DIFFERENT slots', async () => {
    const firstRound = (await run()).slice(0, SLOTS.length)
    expect(new Set(firstRound).size).toBe(SLOTS.length)
  })

  it('no slot reaches step 2 until every slot has had step 1', async () => {
    const order = await run()
    const firstSecondRepair = order.findIndex(a => a.endsWith('2'))
    const before = order.slice(0, firstSecondRepair)
    expect(new Set(before)).toEqual(new Set(['A1', 'B1', 'C1', 'D1']))
  })
})

describe('a settled slot drops out of later rounds', () => {
  it('stops attempting a slot once it passes', async () => {
    // A passes immediately; B passes on its second; C and D never do.
    const r = recorder((slot, step) => slot === 'A' || (slot === 'B' && step === 1))
    await scheduleRepairsBreadthFirst({
      slots: SLOTS, stepsPerSlot: 3, hasBudget: () => true, attempt: r.attempt,
    })
    expect(r.order).toEqual(['A1', 'B1', 'C1', 'D1', 'B2', 'C2', 'D2', 'C3', 'D3'])
    expect(r.order.filter(a => a.startsWith('A'))).toEqual(['A1'])
    expect(r.order.filter(a => a.startsWith('B'))).toEqual(['B1', 'B2'])
  })
})

describe('the budget still stops the run, and reports every slot it never reached', () => {
  it('spends exactly the budget and stops', async () => {
    let calls = 0
    const exhausted: string[] = []
    const r = recorder(() => false)
    await scheduleRepairsBreadthFirst({
      slots: SLOTS,
      stepsPerSlot: repairStepCount(),
      hasBudget: () => calls < 3,
      attempt: async (slot, step) => { calls++; return r.attempt(slot, step) },
      onBudgetExhausted: slot => exhausted.push(slot),
    })
    expect(r.order).toEqual(['A1', 'B1', 'C1'])
    // EVERY slot still unrepaired is reported, not only the one that never got a turn.
    // A, B and C each had an attempt and failed it; D never got one. None of the four was
    // repaired and the budget is gone, so "budget exhausted before this slot could be
    // repaired" is true of all four. Reporting only D would under-report three drops.
    expect(exhausted).toEqual(['A', 'B', 'C', 'D'])
  })

  it('reports every unsettled slot when the budget dies mid-round, not just the next one', async () => {
    let calls = 0
    const exhausted: string[] = []
    await scheduleRepairsBreadthFirst({
      slots: SLOTS,
      stepsPerSlot: repairStepCount(),
      hasBudget: () => calls < 1,
      attempt: async () => { calls++; return false },
      onBudgetExhausted: slot => exhausted.push(slot),
    })
    expect(exhausted).toEqual(['A', 'B', 'C', 'D'])
  })

  it('does not report a slot that already passed', async () => {
    let calls = 0
    const exhausted: string[] = []
    await scheduleRepairsBreadthFirst({
      slots: SLOTS,
      stepsPerSlot: repairStepCount(),
      hasBudget: () => calls < 2,
      attempt: async slot => { calls++; return slot === 'A' },
      onBudgetExhausted: slot => exhausted.push(slot),
    })
    expect(exhausted).not.toContain('A')
    expect(exhausted).toEqual(['B', 'C', 'D'])
  })
})

describe('a slot that uses every step without settling', () => {
  it('is reported as steps-exhausted, not as budget-exhausted', async () => {
    const stepsOut: string[] = []
    const budgetOut: string[] = []
    await scheduleRepairsBreadthFirst({
      slots: ['A'], stepsPerSlot: 2, hasBudget: () => true,
      attempt: async () => false,
      onStepsExhausted: s => stepsOut.push(s),
      onBudgetExhausted: s => budgetOut.push(s),
    })
    expect(stepsOut).toEqual(['A'])
    expect(budgetOut).toEqual([])
  })
})

describe('the plan each slot walks', () => {
  it('is the original angle then every fallback, unchanged by flattening', () => {
    // 3 on the original angle plus 3 on each of 3 fallbacks.
    expect(repairStepCount(3)).toBe(12)
  })

  // The scheduler must never be the thing that limits attempts below the budget.
  it('offers more steps than the budget could ever pay for', () => {
    expect(repairStepCount()).toBeGreaterThan(MAX_API_CALLS_PER_RUN)
  })
})
