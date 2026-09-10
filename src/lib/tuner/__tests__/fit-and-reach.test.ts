// The loop judges on FIT and REACH, and neither alone.
//
// Optimising fit alone rewards making the search tiny: four companies, all perfect, scores
// 100% and serves nobody. Optimising reach alone rewards finding everybody. So both are
// measured, both are reported, and a candidate that trades one for the other reads as a
// trade rather than as an improvement.

import { describe, it, expect } from 'vitest'
import {
  assessFit, compareFit, MIN_FIT_IMPROVEMENT, MIN_RESOLVED_FOR_A_FIGURE,
  LOW_SIGNAL_UNRESOLVED_SHARE, parseFitVerdicts, buildFitJudgePrompt,
  type JudgedCompany, type FitVerdict,
} from '@/lib/tuner/fit-judge'
import { SpendBudget, checkAudience, BILLABLE_PER_LOOKUP } from '@/lib/tuner/run-budget'
import { spreadPositions, RECORD_CEILING, DEFAULT_SAMPLE_SIZE } from '@/lib/tuner/spread-sample'
import { SEARCH_TERMINAL_STATES } from '@/lib/tuner/search-tuner'
import { parseProposedSearch, statedShare } from '@/lib/tuner/proposed-search'

const rows = (counts: Partial<Record<FitVerdict, number>>): JudgedCompany[] => {
  const out: JudgedCompany[] = []
  for (const [verdict, n] of Object.entries(counts)) {
    for (let i = 0; i < (n ?? 0); i++) {
      out.push({
        sourceId: `${verdict}-${i}`, jobTitle: 'T', companyName: 'C',
        verdict: verdict as FitVerdict, reason: '', researchText: null, billableSearches: 0,
      })
    }
  }
  return out
}

describe('both proportions, never collapsed into one', () => {
  it('reports fit of ALL sampled and fit of those ESTABLISHED, separately', () => {
    // 30 of 80 unresolved is inside the measured normal range of 15% to 40%.
    const out = assessFit(rows({ best: 20, acceptable: 10, neither: 20, cannot_establish: 30 }))
    expect(out.sampled).toBe(80)
    expect(out.fitOfAll).toBeCloseTo(30 / 80)
    expect(out.fitOfResolved).toBeCloseTo(30 / 50)
    // They differ by a lot, which is why one number alone would mislead whichever way it
    // was defined: 37.5% against 60% on the same sample.
    expect(out.fitOfAll).not.toBeCloseTo(out.fitOfResolved!)
  })

  it('counts all four verdicts on every round', () => {
    const out = assessFit(rows({ best: 5, acceptable: 7, neither: 9, cannot_establish: 11 }))
    expect([out.best, out.acceptable, out.neither, out.cannotEstablish]).toEqual([5, 7, 9, 11])
  })

  it('never counts an unresolved row as a pass', () => {
    const out = assessFit(rows({ best: 30, cannot_establish: 50 }))
    // Unresolved is in the denominator of the all-rows figure and in neither numerator.
    expect(out.fitOfAll).toBeCloseTo(30 / 80)
    expect(out.fitOfResolved).toBeCloseTo(1)
  })

  it('reports null rather than a number below the resolved floor', () => {
    const out = assessFit(rows({ best: 5, neither: 5, cannot_establish: 70 }))
    expect(out.resolved).toBeLessThan(MIN_RESOLVED_FOR_A_FIGURE)
    expect(out.fitOfResolved).toBeNull()
    // NULL IS "NOT MEASURED", NEVER ZERO. Zero would read as "nothing fitted".
    expect(out.fitOfResolved).not.toBe(0)
  })

  it('reports low signal when most rows could not be established', () => {
    const out = assessFit(rows({ best: 20, neither: 10, cannot_establish: 50 }))
    expect(50 / 80).toBeGreaterThan(LOW_SIGNAL_UNRESOLVED_SHARE)
    expect(out.lowSignal).toBe(true)
  })
})

describe('a change inside the measured noise floor is no change', () => {
  const before = assessFit(rows({ best: 20, acceptable: 10, neither: 20, cannot_establish: 30 })) // 60%
  it('is set from measurement at the sample size actually used', () => {
    // RE-MEASURED with the four-verdict judge actually in use: four draws of 80 from ONE
    // unchanged search gave 50.0, 43.5, 48.6 and 27.6 percent resolved fit, sd 8.9 points,
    // so a difference between two draws carries 12.6. Nineteen is one and a half of those.
    // The threshold went UP, because the extra verdict cost precision.
    expect(MIN_FIT_IMPROVEMENT).toBeCloseTo(0.19)
    expect(DEFAULT_SAMPLE_SIZE).toBe(80)
  })

  it('calls a small movement no change, and says why', () => {
    const after = assessFit(rows({ best: 23, acceptable: 10, neither: 17, cannot_establish: 30 })) // 66%
    const cmp = compareFit(before, after)
    expect(cmp.isRealChange).toBe(false)
    expect(cmp.note).toMatch(/inside the 19-point measured noise floor/)
    expect(cmp.note).toMatch(/unchanged search varied by this much/)
  })

  it('calls a large movement a real change', () => {
    const after = assessFit(rows({ best: 40, acceptable: 5, neither: 5, cannot_establish: 30 })) // 90%
    const cmp = compareFit(before, after)
    expect(cmp.isRealChange).toBe(true)
    expect(cmp.delta!).toBeGreaterThan(MIN_FIT_IMPROVEMENT)
  })

  it('refuses to compare when either round resolved too few rows', () => {
    const thin = assessFit(rows({ best: 3, neither: 2, cannot_establish: 75 }))
    expect(compareFit(before, thin).isRealChange).toBe(false)
    expect(compareFit(before, thin).note).toMatch(/too few rows/)
  })
})

describe('raising best fit by cutting acceptable customers is a trade, not an improvement', () => {
  it('names it a trade and says whose decision it is', () => {
    const before = assessFit(rows({ best: 10, acceptable: 20, neither: 20, cannot_establish: 30 }))
    // Best share rises, but ten acceptable customers were cut out to do it.
    const after = assessFit(rows({ best: 25, acceptable: 5, neither: 20, cannot_establish: 30 }))
    const cmp = compareFit(before, after)
    expect(cmp.isTrade).toBe(true)
    expect(cmp.note).toMatch(/TRADE, not an improvement/)
    expect(cmp.note).toMatch(/real customers being cut out/)
  })

  it('does NOT call it a trade when acceptable customers are kept', () => {
    // The mirror. An implementation that called everything a trade would pass the test above.
    const before = assessFit(rows({ best: 10, acceptable: 20, neither: 20, cannot_establish: 30 }))
    const after = assessFit(rows({ best: 25, acceptable: 20, neither: 5, cannot_establish: 30 }))
    expect(compareFit(before, after).isTrade).toBe(false)
  })
})

describe('an audience the loop may not go below', () => {
  it('rejects a candidate on reach whatever its sample looked like', () => {
    const v = checkAudience(40, { minimumReachable: 5_000, source: 'supplied for this run' })
    expect(v.acceptable).toBe(false)
    expect(v.judged).toBe(true)
    expect(v.reason).toMatch(/REJECTED ON REACH/)
    // BOTH NUMBERS, so the refused trade is visible.
    expect(v.reason).toContain('40')
    expect(v.reason).toContain('5000')
  })

  it('accepts a candidate that clears it', () => {
    expect(checkAudience(9_000, { minimumReachable: 5_000, source: 's' }).acceptable).toBe(true)
  })

  it('says it CANNOT JUDGE when no floor was supplied, and assumes nothing', () => {
    const v = checkAudience(40, undefined)
    expect(v.judged).toBe(false)
    expect(v.acceptable).toBe(false)          // never a silent pass
    expect(v.reason).toMatch(/Nothing is assumed/)
    expect(v.reason).toMatch(/not stored on the organisation record/)
  })
})

describe('the spend cap counts our own calls', () => {
  it('stops before a round it cannot pay for, not part way through one', () => {
    const b = new SpendBudget(100)
    expect(b.canAffordRound(80)).toBe(false)   // 80 x 1.75 = 140 > 100
    expect(b.canAffordRound(40)).toBe(true)    // 40 x 1.75 = 70  <= 100
  })

  it('records billable searches returned, not lookups attempted', () => {
    const b = new SpendBudget(100)
    b.record(2); b.record(1); b.record(2)
    expect(b.lookupsMade).toBe(3)
    expect(b.billableSearches).toBe(5)
    // Measured 1.5 to 1.75 per lookup against a requested cap of one, so the two differ.
    expect(b.billableSearches).not.toBe(b.lookupsMade)
    expect(BILLABLE_PER_LOOKUP).toBeGreaterThan(1)
  })

  it('reports spend in a form a person can check', () => {
    const b = new SpendBudget(400); b.record(2, 9600, 150, 'claude-haiku-4-5-20251001')
    expect(b.describe()).toMatch(/2 billable searches across 1 lookups \(cap 400\)/)
    // The tokens have to be in the line a person reads, or the same blind spot returns:
    // a spend report that shows only searches is a report of just over half the bill.
    expect(b.describe()).toContain('9600 in / 150 out tokens')
    expect(b.describe()).toMatch(/\$\d+\.\d{4} of \$\d+\.\d{4}/)
  })
})

describe('the sample is spread, never page one', () => {
  it('draws distinct positions across the whole reachable range', () => {
    const p = spreadPositions(98_916, 80, mulberry(1))
    expect(new Set(p).size).toBe(p.length)
    expect(p.length).toBe(80)
    expect(Math.max(...p)).toBeGreaterThan(RECORD_CEILING / 2)
    // Not a page: consecutive positions would mean one neighbourhood of the result set.
    expect(Math.max(...p) - Math.min(...p)).toBeGreaterThan(1_000)
  })

  it('never asks past the measured record ceiling', () => {
    // Measured: record 50,000 returns rows and 50,001 returns HTTP 422.
    const p = spreadPositions(5_000_000, 80, mulberry(2))
    expect(Math.max(...p)).toBeLessThanOrEqual(RECORD_CEILING)
  })

  it('returns every position when the population is smaller than the sample', () => {
    expect(spreadPositions(5, 80, mulberry(3))).toEqual([1, 2, 3, 4, 5])
  })

  it('terminates on a pathological random source instead of hanging', () => {
    const p = spreadPositions(10_000, 80, () => 0.5)
    expect(p.length).toBeGreaterThan(0)
    expect(p.length).toBeLessThan(80)
  })
})

describe('every terminal state is distinct', () => {
  it('no state name is a substring of another', () => {
    for (const a of SEARCH_TERMINAL_STATES) {
      for (const b of SEARCH_TERMINAL_STATES) {
        if (a !== b) expect(b.includes(a), `${a} is inside ${b}`).toBe(false)
      }
    }
  })

  it('exactly one state means the work succeeded', () => {
    expect(SEARCH_TERMINAL_STATES.filter(s => s === 'accepted')).toHaveLength(1)
    // "Ran out" states exist and are separate, so neither can render as the other.
    expect(SEARCH_TERMINAL_STATES).toContain('spend_cap_reached')
    expect(SEARCH_TERMINAL_STATES).toContain('wall_clock_exhausted')
    expect(SEARCH_TERMINAL_STATES).toContain('no_combination_reached_the_standard')
  })
})

describe('an element with no traceable reason is not proposed', () => {
  it('drops it and reports the drop rather than storing a blank reason', () => {
    const p = parseProposedSearch({
      categories: [
        { value: 'a', reason: 'the document says so', basis: 'stated' },
        { value: 'b', basis: 'stated' },              // no reason
        { value: 'c', reason: '   ', basis: 'stated' }, // blank reason
      ],
    })
    expect(p.categories).toHaveLength(1)
    expect(p.droppedUntraceable).toEqual([{ axis: 'categories', count: 2 }])
  })

  it('defaults an unrecognised basis to inferred, never to stated', () => {
    const p = parseProposedSearch({ categories: [{ value: 'a', reason: 'r', basis: 'nonsense' }] })
    // Marking a guess as stated would let an unsupported element read as document-backed.
    expect(p.categories[0].basis).toBe('inferred')
    expect(statedShare(p).stated).toBe(0)
  })

  it('drops an inverted range rather than swapping it', () => {
    const p = parseProposedSearch({ size: { min: 500, max: 5, reason: 'r', basis: 'stated' } })
    expect(p.size).toBeNull()
  })

  it('refuses an omission of an axis that is not omittable', () => {
    const p = parseProposedSearch({ omit: [{ value: 'person_countries', reason: 'r' }] })
    expect(p.omit).toHaveLength(0)
    expect(p.droppedUntraceable.some(d => d.axis === 'omit')).toBe(true)
  })
})

describe('the fit judge prompt and parser', () => {
  it('offers four answers and tells the judge that abstaining is correct', () => {
    const prompt = buildFitJudgePrompt({ sells: 's', usedFor: 'u', bestDescription: 'b', acceptableDescription: 'a' })
    for (const v of ['best', 'acceptable', 'neither', 'cannot_establish']) expect(prompt).toContain(v)
    expect(prompt).toMatch(/correct answer and it is common/)
    expect(prompt).toMatch(/Do not push them into "neither" because they are second choice/)
  })

  it('ignores a verdict outside the four', () => {
    expect(parseFitVerdicts('{"verdicts":[{"id":"a","verdict":"probably"}]}')).toHaveLength(0)
  })

  it('survives a response that is not JSON', () => {
    expect(parseFitVerdicts('I cannot help with that.')).toEqual([])
  })
})

/** A deterministic random source, so a sampling test cannot pass or fail by luck. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
