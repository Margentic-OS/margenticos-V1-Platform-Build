// THE THREE COST ARMS, AND THE PROPERTY THAT MATTERS MOST: ALL OFF BY DEFAULT.
//
// Each arm changes what a paid call costs, so merging them must not alter production on its
// own. The first describe block is therefore the important one, and every other assertion in
// this file is worth less than it.
//
// RULE ZERO. Every fixture is invented and industry-neutral.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  candidateCap, candidateCapInstruction, synthesisModelOverride, briefWebSearch,
  activeArms, ARM_SYNTHESIS_MODELS,
} from '../cost-arms'
import { USD_PER_MTOK } from '../cost-constants'

const ARM_VARS = ['ARM_CANDIDATE_CAP', 'ARM_SYNTHESIS_MODEL', 'ARM_BRIEF_WEB_SEARCH'] as const

beforeEach(() => { for (const v of ARM_VARS) vi.stubEnv(v, '') })
afterEach(() => { vi.unstubAllEnvs() })

describe('every arm is OFF unless deliberately set', () => {
  it('reads off with the variables absent', () => {
    for (const v of ARM_VARS) vi.stubEnv(v, '')
    expect(candidateCap()).toBeNull()
    expect(synthesisModelOverride()).toBeNull()
    expect(briefWebSearch()).toBe(false)
    expect(activeArms()).toEqual({})
  })

  it('treats every near-miss truthy value as OFF for the boolean arm', () => {
    // '1', 'yes' and 'TRUE' all look on to a human and must not be. A flag that turns itself
    // on for a value somebody guessed is worse than no flag: it spends money unasked.
    for (const v of ['1', 'yes', 'TRUE', 'True', 'on', ' true']) {
      vi.stubEnv('ARM_BRIEF_WEB_SEARCH', v)
      expect(briefWebSearch(), `"${v}" must be off`).toBe(false)
    }
  })

  it('turns on for exactly "true"', () => {
    // The positive control for the assertion above. Without it, a function that always
    // returned false would pass every near-miss case.
    vi.stubEnv('ARM_BRIEF_WEB_SEARCH', 'true')
    expect(briefWebSearch()).toBe(true)
    expect(activeArms()).toEqual({ ARM_BRIEF_WEB_SEARCH: 'true' })
  })

  it('is read per call, not captured at module load', () => {
    // A module-level const would be captured when the process started, which breaks a script
    // that sets the variable and then imports the agent, and any test that wants both sides.
    vi.stubEnv('ARM_BRIEF_WEB_SEARCH', '')
    expect(briefWebSearch()).toBe(false)
    vi.stubEnv('ARM_BRIEF_WEB_SEARCH', 'true')
    expect(briefWebSearch()).toBe(true)
  })
})

describe('arm A: the candidate cap', () => {
  it('reads a positive integer', () => {
    vi.stubEnv('ARM_CANDIDATE_CAP', '4')
    expect(candidateCap()).toBe(4)
  })

  it('REFUSES a value that is not a positive integer, rather than treating it as off', () => {
    // Silently reading "no cap" from a typo would report the arm as having run when it did
    // not, which is the one result that would be believed and wrong.
    for (const bad of ['0', '-1', '4.5', 'four', '']) {
      vi.stubEnv('ARM_CANDIDATE_CAP', bad)
      if (bad === '') { expect(candidateCap()).toBeNull(); continue }
      expect(() => candidateCap(), `"${bad}" must throw`).toThrow(/positive integer/)
    }
  })

  it('caps what is WRITTEN OUT and explicitly not what is considered', () => {
    // The distinction is the whole arm. Considering fewer candidates would change the verdict
    // by changing the evidence; reporting fewer changes the bill.
    const t = candidateCapInstruction(4)
    expect(t).toMatch(/Consider every candidate/i)
    expect(t).toMatch(/WRITE OUT only the strongest 4/)
    expect(t).toMatch(/do not\s+change how you score or select/i)
  })

  it('keeps the selected candidate inside what it reports', () => {
    // Without this the model could report its top 4 and select a fifth, and the row would
    // carry a selected_candidate_id matching nothing.
    expect(candidateCapInstruction(4)).toMatch(/selected candidate must be among/i)
  })

  it('starts with a blank line, so it cannot fuse onto the previous instruction', () => {
    expect(candidateCapInstruction(4).startsWith('\n\n')).toBe(true)
  })
})

describe('arm B: the cheaper synthesis model', () => {
  it('accepts a listed model', () => {
    vi.stubEnv('ARM_SYNTHESIS_MODEL', 'claude-haiku-4-5-20251001')
    expect(synthesisModelOverride()).toBe('claude-haiku-4-5-20251001')
  })

  it('REFUSES an unlisted model, because its ledger row could not be priced', () => {
    vi.stubEnv('ARM_SYNTHESIS_MODEL', 'claude-something-cheap')
    expect(() => synthesisModelOverride()).toThrow(/cannot be priced/)
  })

  it('every listed model IS priceable, which is the reason the list exists', () => {
    // The list and USD_PER_MTOK are two lists that must agree. This is the check that they do.
    for (const m of ARM_SYNTHESIS_MODELS) {
      expect(USD_PER_MTOK[m], `${m} must be in USD_PER_MTOK`).toBeDefined()
    }
  })

  it('the listed model is actually cheaper than the one it replaces', () => {
    // An arm that swapped in a MORE expensive model would still pass every test above.
    const haiku = USD_PER_MTOK['claude-haiku-4-5-20251001']
    const sonnet = USD_PER_MTOK['claude-sonnet-4-6']
    expect(haiku.input).toBeLessThan(sonnet.input)
    expect(haiku.output).toBeLessThan(sonnet.output)
  })
})

describe('activeArms, which is what a run prints and a ledger row carries', () => {
  it('reports every variable that is set', () => {
    vi.stubEnv('ARM_CANDIDATE_CAP', '4')
    vi.stubEnv('ARM_SYNTHESIS_MODEL', 'claude-haiku-4-5-20251001')
    vi.stubEnv('ARM_BRIEF_WEB_SEARCH', 'true')
    expect(activeArms()).toEqual({
      ARM_CANDIDATE_CAP: '4',
      ARM_SYNTHESIS_MODEL: 'claude-haiku-4-5-20251001',
      ARM_BRIEF_WEB_SEARCH: 'true',
    })
  })

  it('is empty when nothing is set, which is how the runner detects a forgotten variable', () => {
    expect(activeArms()).toEqual({})
  })
})
