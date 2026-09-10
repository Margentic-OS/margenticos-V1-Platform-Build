// The ceiling that stops a run, and the prices it stops on.
//
// A cap counted in searches bounded 57% of the bill, because nothing counted the tokens the
// search tool injects. These tests exist so that stays fixed: each one fails if the money
// side of the ceiling is removed, not merely if the search side is.

import { describe, it, expect } from 'vitest'
import { SpendBudget, MEASURED_USD_PER_LOOKUP } from '@/lib/tuner/run-budget'
import { LookupBudget, type LookupResult } from '@/lib/tuner/lookup'
import { tokenCost, isPricedModel, MODEL_PRICES, PRICE_PER_BILLABLE_SEARCH } from '@/lib/tuner/pricing'

const HAIKU = 'claude-haiku-4-5-20251001'

/** A lookup shaped like the measured one: 1 search, ~9,600 in, ~150 out. */
const measuredLookup = (over: Partial<LookupResult> = {}): LookupResult => ({
  text: 'A description long enough to be usable, running past the module minimum comfortably.',
  limited: false,
  billableSearches: 1,
  inputTokens: 9600,
  outputTokens: 150,
  model: HAIKU,
  ...over,
})

describe('the ceiling counts tokens, not only search fees', () => {
  it('charges a lookup for its tokens as well as its fee', () => {
    const budget = new SpendBudget(400, 100)
    budget.record(1, 9600, 150, HAIKU)

    const feeOnly = PRICE_PER_BILLABLE_SEARCH
    // If the tokens were dropped the total would equal the fee exactly. It must not.
    expect(budget.spentUsd).toBeGreaterThan(feeOnly)
    expect(budget.inputTokens).toBe(9600)
    expect(budget.outputTokens).toBe(150)
  })

  it('stops on the money cap while the search cap still has room', () => {
    // A thousand searches of headroom, ten cents of money. The money must be what bites.
    const budget = new SpendBudget(1000, 0.10)
    expect(budget.exhausted).toBe(false)
    for (let i = 0; i < 5; i++) budget.record(1, 9600, 150, HAIKU)

    expect(budget.billableSearches).toBeLessThan(budget.capSearches)
    expect(budget.exhausted).toBe(true)
    expect(budget.stopReason).toBe('money_cap')
  })

  it('refuses to START a round it cannot pay for in full', () => {
    // The stop has to be clean: a proportion computed on half a sample is biased towards
    // whatever the provider returned first, so a half-funded round must never begin.
    const budget = new SpendBudget(10_000, 40 * MEASURED_USD_PER_LOOKUP + 0.01)
    expect(budget.canAffordRound(40)).toBe(true)
    expect(budget.canAffordRound(80)).toBe(false)
  })

  it('the money check is not satisfied by search headroom alone', () => {
    // Searches wide open, money nearly gone. canAffordRound must still refuse.
    const budget = new SpendBudget(1_000_000, 0.05)
    expect(budget.remaining).toBeGreaterThan(1000)
    expect(budget.canAffordRound(80)).toBe(false)
  })
})

describe('an unknown model is priced high, never at zero', () => {
  it('prices a renamed model at the most expensive published rate', () => {
    const dearest = Object.values(MODEL_PRICES).reduce((a, b) => (b.input > a.input ? b : a))
    expect(isPricedModel('claude-something-not-shipped-yet')).toBe(false)
    expect(tokenCost('claude-something-not-shipped-yet', 1_000_000, 0)).toBeCloseTo(dearest.input * 1_000_000, 6)
  })

  it('never returns zero for real tokens on an unnamed model', () => {
    // A ceiling that silently stops counting when a model is renamed is not a ceiling, and
    // a rename is exactly when nobody is watching.
    expect(tokenCost(null, 100_000, 100_000)).toBeGreaterThan(0)
  })

  it('flags that a figure was priced at the fallback rate', () => {
    const budget = new SpendBudget(400, 100)
    budget.record(1, 1000, 100, 'claude-something-not-shipped-yet')
    expect(budget.pricedOnAnUnknownModel).toBe(true)
    expect(budget.describe()).toContain('fallback rate')
  })
})

describe('the lookup budget stops on money too', () => {
  it('refuses the next lookup once the money is gone, with room on the lookup count', () => {
    const budget = new LookupBudget(1000, 0.10)
    expect(budget.exhausted).toBe(false)
    for (let i = 0; i < 5; i++) budget.record(`org-${i}`, measuredLookup())

    expect(budget.lookups).toBeLessThan(budget.maxLookups)
    expect(budget.exhausted).toBe(true)
    expect(budget.stopReason).toBe('money_cap')
  })

  it('a failed lookup contributes no tokens and does not overstate the bill', () => {
    const budget = new LookupBudget(10)
    budget.record('org-a', measuredLookup({ billableSearches: 0, inputTokens: 0, outputTokens: 0, model: null }))
    expect(budget.spentUsd).toBe(0)
  })

  it('reports spend as it goes rather than only at the end', () => {
    const budget = new LookupBudget(10, 5)
    budget.record('org-a', measuredLookup())
    const line = budget.describe()
    expect(line).toContain('1 lookups')
    expect(line).toContain('9600 in')
    expect(line).toContain('of $5.0000')
  })
})
