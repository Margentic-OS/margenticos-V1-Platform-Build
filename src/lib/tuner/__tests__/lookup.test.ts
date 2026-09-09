// THE ONLY PART OF THE TUNER THAT COSTS MONEY, and the guards on it.
//
// The cap is enforced by counting OUR OWN calls, because the provider's own limit parameter
// is not a billable bound: measured 2026-09-08 across two runs, nine lookups requested with
// the cap set to one returned fifteen billable searches.

import { describe, it, expect, vi, afterEach } from 'vitest'

const webSearch = vi.fn()
vi.mock('@/lib/agents/tools/webSearch', () => ({ webSearch: (...a: unknown[]) => webSearch(...a) }))

import {
  LookupBudget, lookUpCompany, lookupIsUsable, buildLookupQuery, MIN_USEFUL_LOOKUP_CHARS,
} from '@/lib/tuner/lookup'

afterEach(() => { webSearch.mockReset() })

// Carries the COST fields as well as the content ones. A fake that omits a field the code
// under test reads does not fail: it hands back undefined, which flows into the budget and
// makes every spend figure NaN or zero while every assertion here still passes. The tokens
// are the majority of the bill, so a fake that silently drops them is a fake that cannot
// test the ceiling that stops a run.
const good = (searches = 2, inputTokens = 9000, outputTokens = 300) => ({
  synthesis: 'A description long enough to be usable, running past the minimum length the ' +
    'module requires before it will treat a lookup as having resolved anything at all.',
  limited: false,
  searchCount: searches,
  inputTokens,
  outputTokens,
  model: 'claude-haiku-4-5-20251001',
})

describe('the cap counts our own calls, never the provider\'s promise', () => {
  it('stops making lookups once the cap is reached', async () => {
    webSearch.mockResolvedValue(good())
    const budget = new LookupBudget(2)

    expect(await lookUpCompany('Alpha-1', budget)).not.toBeNull()
    expect(await lookUpCompany('Alpha-2', budget)).not.toBeNull()
    // The third is refused by US, not by the provider.
    expect(await lookUpCompany('Alpha-3', budget)).toBeNull()

    expect(webSearch).toHaveBeenCalledTimes(2)
    expect(budget.lookups).toBe(2)
    expect(budget.exhausted).toBe(true)
  })

  it('reports BILLABLE SEARCHES RETURNED, not lookups attempted', async () => {
    // Each lookup asks for one and the provider returns two. Reporting lookups would
    // understate the bill by half, which is the defect this whole design is built around.
    webSearch.mockResolvedValue(good(2))
    const budget = new LookupBudget(3)
    await lookUpCompany('Alpha-1', budget)
    await lookUpCompany('Alpha-2', budget)

    expect(budget.lookups).toBe(2)
    expect(budget.billableSearches).toBe(4)
    expect(budget.billableSearches).not.toBe(budget.lookups)
  })

  it('asks the provider for one search AND for the brief read, while not relying on either', async () => {
    webSearch.mockResolvedValue(good(3))
    await lookUpCompany('Alpha-1', new LookupBudget(5))
    // brief is the half of this that actually worked. maxUses is advisory and measured 1.48
    // searches per lookup against a cap of 1; the brief framing took it to 1.00.
    expect(webSearch).toHaveBeenCalledWith(expect.any(String), { maxUses: 1, brief: true })
  })

  it('counts a failed lookup against the cap, and bills nothing for it', async () => {
    // Otherwise a run whose lookups all fail bypasses the cap entirely and keeps paying.
    webSearch.mockRejectedValue(new Error('provider down'))
    const budget = new LookupBudget(1)
    const result = await lookUpCompany('Alpha-1', budget)
    expect(budget.lookups).toBe(1)
    expect(budget.billableSearches).toBe(0)
    expect(result?.limited).toBe(true)
    expect(budget.exhausted).toBe(true)
  })
})

describe('a name already resolved is never looked up again', () => {
  it('serves the second request from the first result', async () => {
    webSearch.mockResolvedValue(good())
    const budget = new LookupBudget(5)

    await lookUpCompany('Alpha-1', budget)
    await lookUpCompany('Alpha-1', budget)
    await lookUpCompany('  alpha-1  ', budget)   // case and whitespace only

    expect(webSearch).toHaveBeenCalledTimes(1)
    expect(budget.lookups).toBe(1)
  })

  it('does NOT merge two names that differ by more than case and spacing', async () => {
    // Deliberately not clever. Stripping suffixes or punctuation would merge two genuinely
    // different organisations and apply one's verdict to the other, and being wrong about a
    // company is worse than paying twice for a near duplicate.
    webSearch.mockResolvedValue(good())
    const budget = new LookupBudget(5)
    await lookUpCompany('Alpha-1', budget)
    await lookUpCompany('Alpha-1 Holdings', budget)
    expect(webSearch).toHaveBeenCalledTimes(2)
  })
})

describe('a page with nothing useful on it does not become a verdict', () => {
  it('treats a limited result as no result', () => {
    expect(lookupIsUsable({ text: 'x'.repeat(500), limited: true, billableSearches: 1, inputTokens: 0, outputTokens: 0, model: null })).toBe(false)
  })

  it('treats a too-short result as no result', () => {
    expect(lookupIsUsable({ text: 'Nothing here.', limited: false, billableSearches: 1, inputTokens: 0, outputTokens: 0, model: null })).toBe(false)
    expect('Nothing here.'.length).toBeLessThan(MIN_USEFUL_LOOKUP_CHARS)
  })

  it('treats a real result as usable', () => {
    // Shaped as a LookupResult, which is what this predicate reads. `good()` above is the
    // WEB SEARCH's shape and carries `synthesis`; they are different types on purpose and
    // passing one where the other belongs is what this line would otherwise hide.
    expect(lookupIsUsable({ text: good().synthesis, limited: false, billableSearches: 2, inputTokens: 0, outputTokens: 0, model: null })).toBe(true)
  })

  it('treats a refused lookup as no result', () => {
    // Null means the cap stopped us. That is "still unknown", not "we looked and found
    // nothing", and both must fail the usability test for the same downstream reason.
    expect(lookupIsUsable(null)).toBe(false)
  })

  it('the query names no sector and carries only the employer name', () => {
    const q = buildLookupQuery('Zqv-1234')
    expect(q).toContain('Zqv-1234')
    expect(q.toLowerCase()).not.toMatch(/consult|software|school|health|retail|logistic/)
  })
})
