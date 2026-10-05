// The upload hold for the short_reasoning arm, asserted two ways:
//   1. applySendGate applies RESEARCH_ARM_RELEASED_CLAUSE. A recording fake that throws on anything it
//      does not implement, so removing the clause from the gate makes this test fail.
//   2. The clause itself, evaluated the way PostgREST reads it, admits exactly the rows it should:
//      no arm, standard, and a released short arm. It holds an unreleased short arm.
//
// The second is the semantic claim. The first only proves the clause is in the gate.

import { describe, it, expect } from 'vitest'
import { applySendGate, RESEARCH_ARM_RELEASED_CLAUSE } from '../send-gate'

interface Call { method: string; args: unknown[] }

function recordingBuilder(): { builder: unknown; calls: Call[] } {
  const calls: Call[] = []
  const chain: Record<string, unknown> = {}
  const self: unknown = new Proxy(chain, {
    get(target, prop) {
      if (prop in target) return target[prop as keyof typeof target]
      if (typeof prop === 'symbol') return undefined
      throw new Error(`fake does not implement .${String(prop)}() — applySendGate uses it, so this test is not measuring production`)
    },
  })
  const record = (method: string) => (...args: unknown[]) => { calls.push({ method, args }); return self }
  for (const m of ['eq', 'not', 'is', 'or']) chain[m] = record(m)
  return { builder: self, calls }
}

/**
 * PostgREST's or=(...) reads a comma-separated list of `column.operator.value` terms, and
 * `column.not.is.null` negates the `is` term. This evaluates the three terms the clause uses.
 */
function admits(row: { research_arm: string | null; research_arm_released_at: string | null }): boolean {
  return RESEARCH_ARM_RELEASED_CLAUSE.split(',').some(term => {
    const [col, ...rest] = term.split('.')
    const value = row[col as keyof typeof row]
    if (rest.join('.') === 'is.null') return value === null
    if (rest.join('.') === 'not.is.null') return value !== null
    if (rest[0] === 'eq') return value === rest.slice(1).join('.')
    throw new Error(`unexpected clause term: ${term}`)
  })
}

describe('research arm: the upload hold', () => {
  it('applySendGate applies the research-arm clause exactly once', () => {
    const { builder, calls } = recordingBuilder()
    applySendGate(builder as never, 'org-1')
    const orCalls = calls.filter(c => c.method === 'or')
    expect(orCalls).toEqual([{ method: 'or', args: [RESEARCH_ARM_RELEASED_CLAUSE] }])
  })

  it('admits a prospect with no arm, a standard prospect, and a released short prospect', () => {
    expect(admits({ research_arm: null, research_arm_released_at: null })).toBe(true)
    expect(admits({ research_arm: 'standard', research_arm_released_at: null })).toBe(true)
    expect(admits({ research_arm: 'short_reasoning', research_arm_released_at: '2026-10-06T09:00:00Z' })).toBe(true)
  })

  it('holds a short prospect until its batch is approved', () => {
    expect(admits({ research_arm: 'short_reasoning', research_arm_released_at: null })).toBe(false)
  })

  it('leaves every other clause of the gate in place, in the same order, with the hold last', () => {
    const { builder, calls } = recordingBuilder()
    applySendGate(builder as never, 'org-1')
    expect(calls.map(c => c.method)).toEqual(['eq', 'eq', 'not', 'not', 'eq', 'eq', 'eq', 'or'])
  })
})
