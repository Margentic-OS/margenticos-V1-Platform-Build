import { describe, it, expect } from 'vitest'
import { parseHeadcountRange } from '@/lib/agents/icp-filter-spec'

// The three measured failures of the previous first-integer/second-integer parser. Each one
// reached company_headcount_max, which resolveHeadcountCeiling uses to REMOVE prospects.
describe('the failures that motivated the rewrite', () => {
  it('reads a bare lower bound as a lower bound, not as a min with a fallback max', () => {
    // Was: min 500, max null -> caller's ?? gave max 20, so min > max.
    expect(parseHeadcountRange('Over 500 employees')).toEqual({ min: 500, max: null })
  })

  it('does not split comma-grouped thousands into separate bounds', () => {
    // Was: min 1, max 0. It read "1" and "000" as the two bounds.
    expect(parseHeadcountRange('1,000-5,000 employees')).toEqual({ min: 1000, max: 5000 })
  })

  it('reads an upper bound as an upper bound rather than flipping it', () => {
    // Was: min 10, meaning inverted.
    expect(parseHeadcountRange('Fewer than 10 people')).toEqual({ min: null, max: 10 })
  })
})

describe('bounds and ranges', () => {
  it.each([
    ['Under 50',                { min: null, max: 50 }],
    ['Up to 250 employees',     { min: null, max: 250 }],
    ['Fewer than 1,000 employees', { min: null, max: 1000 }],
    ['At least 20 staff',       { min: 20, max: null }],
    ['20+ employees',           { min: 20, max: null }],
    ['2,500 to 10,000',         { min: 2500, max: 10000 }],
    ['10',                      { min: 10, max: 10 }],
    ['approximately 12 people', { min: 12, max: 12 }],
  ])('parses %j', (raw, expected) => {
    expect(parseHeadcountRange(raw as string)).toEqual(expected)
  })

  it('reads a range written in either order', () => {
    expect(parseHeadcountRange('80-20 people')).toEqual({ min: 20, max: 80 })
    expect(parseHeadcountRange('20-80 people')).toEqual({ min: 20, max: 80 })
  })

  it('never returns an inverted pair for any input it can parse', () => {
    const inputs = [
      'Over 500 employees', '1,000-5,000 employees', 'Fewer than 10 people', 'Under 50',
      'Up to 250 employees', 'At least 20 staff', '20+ employees', '80-20 people',
      '2,500 to 10,000', 'Fewer than 1,000 employees', '10', 'Varies', '',
      'Under 10 or over 150 with established operational leadership',
    ]
    for (const raw of inputs) {
      const { min, max } = parseHeadcountRange(raw)
      if (min !== null && max !== null) expect(min, raw).toBeLessThanOrEqual(max)
    }
  })

  it('reports no bound at all rather than inventing one', () => {
    // A silent 1-20 here is what the deleted caller fallbacks produced, and 20 is a ceiling
    // that removes prospects. Unbounded must stay visibly unbounded.
    expect(parseHeadcountRange('Varies')).toEqual({ min: null, max: null })
    expect(parseHeadcountRange('')).toEqual({ min: null, max: null })
    expect(parseHeadcountRange(null)).toEqual({ min: null, max: null })
  })
})

// These are the tier 1 and tier 2 strings stored for the five live organisations, which are
// the only headcount strings deriveFilterSpec actually reads. The rewrite must not move any
// of them: a change here silently re-filters a live client's prospects.
describe('the stored strings do not move', () => {
  it.each([
    ['8-30 staff (teaching and administrative combined)', 8, 30],
    ['8-30 staff', 8, 30],
    ['15-80 staff', 15, 80],
    ['50-120 staff', 50, 120],
    ['5 to 20 people', 5, 20],
    ['1–5 people (founder plus contractors or a small delivery team)', 1, 5],
    ['5–15 people, with at least one person doing some business development but not full-time or not effectively', 5, 15],
    ['10-80 people', 10, 80],
    ['50-500 (facility-level staff, with a dedicated procurement or facilities team of 2-10 people)', 50, 500],
    ['1-5 people', 1, 5],
  ])('%j stays %i to %i', (raw, min, max) => {
    expect(parseHeadcountRange(raw as string)).toEqual({ min, max })
  })
})
