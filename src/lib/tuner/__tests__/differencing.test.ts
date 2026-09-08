// WEAK AND REDUNDANT ARE DIFFERENT SIGNALS, AND THIS IS THE TEST THAT SAYS SO.
//
// The distinction is the whole reason differencing is item-level rather than layer-level, and
// it is easy to lose: both look like "removing it changed nothing" if you only measure the
// removal. Measured on a live organisation 2026-09-08, one search carried a job title scoring
// 4,068 alone whose removal moved the population by zero, alongside a word scoring 39 alone
// whose removal also moved it by zero. Collapsing those into one signal deletes both.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { installFakeProvider, type FakeProvider } from './fake-provider'
import { differenceSearch, WEAK_SHARE, DOMINANCE_SHARE } from '@/lib/tuner/differencing'
import { ProviderBudget } from '@/lib/tuner/count-and-sample'

let provider: FakeProvider | null = null
afterEach(() => { provider?.restore(); provider = null; vi.restoreAllMocks() })

const POPULATION = 11_191

/**
 * A search whose title layer contains, deliberately, one of each shape.
 *
 * index 0  scores 4,068 alone and its removal changes nothing  -> REDUNDANT, not weak
 * index 1  scores 39 alone and its removal changes nothing     -> WEAK and redundant
 * index 2  scores 8,657 alone and its removal costs 8,000      -> DOMINANT, neither
 *
 * The numbers are the measured ones from the live organisation, so this exercises the shape
 * that actually occurs.
 */
function population(req: Record<string, unknown>): number {
  const titles = Array.isArray(req.person_titles) ? (req.person_titles as string[]) : []
  const codes = Array.isArray(req.organization_naics_codes) ? (req.organization_naics_codes as string[]) : []

  if (codes.length === 0) return 38_888
  if (titles.length === 0) return 39_140

  // Alone.
  if (titles.length === 1) {
    if (titles[0] === 't0') return 4_068
    if (titles[0] === 't1') return 39
    if (titles[0] === 't2') return 8_657
  }
  // Removed, siblings kept. t0 and t1 are covered by their siblings; t2 is not.
  if (titles.length === 2 && !titles.includes('t2')) return 3_191
  if (titles.length === 2) return POPULATION
  return POPULATION
}

const REQUEST = {
  organization_naics_codes: ['c0'],
  person_titles: ['t0', 't1', 't2'],
}

describe('differencing separates a weak item from a redundant one', () => {
  it('marks the high-scoring covered item redundant but NOT weak', async () => {
    provider = installFakeProvider({ populationFor: population })
    const result = await differenceSearch(REQUEST, new ProviderBudget(100, 0))

    const t0 = result.items.find(i => i.axis === 'job_title' && i.index === 0)!
    expect(t0.alone).toBe(4_068)
    expect(t0.withoutIt).toBe(POPULATION)
    expect(t0.redundant).toBe(true)

    // THE ASSERTION THAT MATTERS. This item finds four thousand people. Calling it weak
    // would be evidence to delete it, and deleting it would take them with it.
    expect(t0.weak).toBe(false)
  })

  it('marks the low-scoring item weak, and separately redundant', async () => {
    provider = installFakeProvider({ populationFor: population })
    const result = await differenceSearch(REQUEST, new ProviderBudget(100, 0))

    const t1 = result.items.find(i => i.axis === 'job_title' && i.index === 1)!
    expect(t1.alone).toBe(39)
    expect(t1.weak).toBe(true)
    expect(t1.redundant).toBe(true)

    // Both flags are true here, and they are still two flags. An item can be both; what it
    // must never do is have one inferred from the other.
    expect(t1.weak).not.toBe(undefined)
  })

  it('the two flags are computed from different measurements', async () => {
    provider = installFakeProvider({ populationFor: population })
    const result = await differenceSearch(REQUEST, new ProviderBudget(100, 0))
    const titles = result.items.filter(i => i.axis === 'job_title')

    // Across the three items every combination that should occur does, which is only
    // possible if the two flags read different numbers.
    const shapes = titles.map(t => `${t.weak ? 'W' : '-'}${t.redundant ? 'R' : '-'}`)
    expect(shapes).toContain('-R')   // redundant, not weak
    expect(shapes).toContain('WR')   // both
    expect(shapes).toContain('--')   // neither
  })

  it('flags the dominant item without calling it weak or redundant', async () => {
    provider = installFakeProvider({ populationFor: population })
    const result = await differenceSearch(REQUEST, new ProviderBudget(100, 0))
    const t2 = result.items.find(i => i.axis === 'job_title' && i.index === 2)!

    expect(t2.alone).toBe(8_657)
    expect(t2.dominant).toBe(true)
    expect(t2.weak).toBe(false)
    expect(t2.redundant).toBe(false)
    expect(t2.alone).toBeGreaterThanOrEqual(DOMINANCE_SHARE * POPULATION)
  })

  it('the weak threshold is a share of the population, not an absolute count', () => {
    // Populations measured on live organisations spanned 1 to 98,984 on the same day. An
    // absolute floor meaningful at the top makes everything weak at the bottom.
    expect(WEAK_SHARE).toBeLessThan(0.05)
    expect(39).toBeLessThan(WEAK_SHARE * POPULATION)
    expect(4_068).toBeGreaterThan(WEAK_SHARE * POPULATION)
  })
})

describe('an inert layer is not automatically a parameter the provider ignored', () => {
  it('does NOT suspect an ignored parameter when a member finds somebody alone', async () => {
    // The shape measured on a live organisation: removing the whole word layer changes
    // nothing, AND one of the words returns a non-zero count on its own. The parameter is
    // plainly being honoured; the layer is inert because the market makes it so.
    provider = installFakeProvider({
      populationFor: req => {
        const words = Array.isArray(req.q_organization_keyword_tags)
          ? (req.q_organization_keyword_tags as string[]) : []
        if (words.length === 1 && words[0] === 'w0') return 3
        if (words.length === 1) return 142
        return 142
      },
    })

    const result = await differenceSearch(
      { organization_naics_codes: ['c0'], q_organization_keyword_tags: ['w0', 'w1'] },
      new ProviderBudget(100, 0),
    )

    expect(result.layers.find(l => l.axis === 'search_word')!.inert).toBe(true)
    expect(result.suspectedIgnoredAxes).not.toContain('search_word')
  })

  it('DOES suspect one when the layer is inert and no member finds anybody', async () => {
    provider = installFakeProvider({
      populationFor: req => {
        const words = Array.isArray(req.q_organization_keyword_tags)
          ? (req.q_organization_keyword_tags as string[]) : []
        // Every subset returns the same number, including single words: the parameter is
        // making no difference at all, which is what being ignored looks like.
        return words.length === 1 ? 0 : 500
      },
    })

    const result = await differenceSearch(
      { organization_naics_codes: ['c0'], q_organization_keyword_tags: ['w0', 'w1'] },
      new ProviderBudget(100, 0),
    )
    expect(result.suspectedIgnoredAxes).toContain('search_word')
  })

  it('reports nothing suspect on an empty population, where every layer is trivially inert', async () => {
    provider = installFakeProvider({ populationFor: () => 0 })
    const result = await differenceSearch(
      { organization_naics_codes: ['c0'], q_organization_keyword_tags: ['w0'] },
      new ProviderBudget(100, 0),
    )
    // Otherwise a client with no reachable population would be reported as having a broken
    // provider parameter, which is a different and much more alarming claim.
    expect(result.suspectedIgnoredAxes).toEqual([])
  })
})

describe('the fake honours what it is asked, so these tests can fail', () => {
  it('sends the constraint it claims to send', async () => {
    provider = installFakeProvider({ populationFor: population })
    await differenceSearch(REQUEST, new ProviderBudget(100, 0))

    // Positive control on the instrument. If the code under test stopped sending
    // person_titles at all, every number above would still be produced by the fake's
    // fall-through and the assertions would be measuring nothing.
    const soloTitleCalls = provider.calls.filter(
      c => Array.isArray(c.person_titles) && (c.person_titles as unknown[]).length === 1,
    )
    expect(soloTitleCalls).toHaveLength(3)
  })
})
