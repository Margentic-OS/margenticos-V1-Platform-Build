// THE ONLY PART OF THE TUNER THAT COSTS MONEY, and the guards on it.
//
// The cap is enforced by counting OUR OWN calls, because the provider's own limit parameter
// is not a billable bound: measured 2026-09-08 across two runs, nine lookups requested with
// the cap set to one returned fifteen billable searches.

import { describe, it, expect, vi, afterEach } from 'vitest'

const webSearch = vi.fn()
vi.mock('@/lib/agents/tools/webSearch', () => ({ webSearch: (...a: unknown[]) => webSearch(...a) }))

import {
  LookupBudget, lookUpCompany, lookUpMany, lookupIsUsable, buildLookupQuery, MIN_USEFUL_LOOKUP_CHARS,
} from '@/lib/tuner/lookup'
import { FatalApiError } from '@/lib/agents/fatal-api-error'

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

describe('a billing or auth failure stops the lookups, and is never recorded as a company we could not research', () => {
  // MEASURED 2026-09-10: the credit balance ran out partway through a paid 220-company round.
  // The lookup step used to catch that failure and record a failed lookup, which the judge
  // reads as "could not establish" for that company: a verdict about the company, entered
  // into the fit proportion, with no error anywhere. It is the account, not the company.

  const FATAL = () => new FatalApiError('Anthropic credit balance exhausted (Anthropic web search)', 'placeholder')

  it('rethrows a fatal failure from the search, and records no lookup for it', async () => {
    webSearch.mockRejectedValue(FATAL())
    const budget = new LookupBudget(10)
    await expect(lookUpCompany('Alpha-1', budget)).rejects.toBeInstanceOf(FatalApiError)
    expect(budget.lookups).toBe(0)
    expect(budget.cached('Alpha-1')).toBeUndefined()
  })

  it('treats the raw billing message the provider actually sends as fatal too', async () => {
    // The exact shape that reached the top of the failed run, in case a change upstream ever
    // stops wrapping it.
    webSearch.mockRejectedValue(new Error(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}',
    ))
    const budget = new LookupBudget(10)
    await expect(lookUpCompany('Alpha-1', budget)).rejects.toBeInstanceOf(FatalApiError)
    expect(budget.lookups).toBe(0)
  })

  it('CONTROL: an ordinary failure is still one company that could not be researched', async () => {
    webSearch.mockRejectedValue(new Error('placeholder transient failure'))
    const budget = new LookupBudget(10)
    const result = await lookUpCompany('Alpha-1', budget)
    expect(result?.limited).toBe(true)
    expect(budget.lookups).toBe(1)
  })

  it('the batch stops at the first fatal failure and rejects, one at a time', async () => {
    let calls = 0
    webSearch.mockImplementation(async () => {
      calls++
      if (calls === 3) throw FATAL()
      return good()
    })
    const names = Array.from({ length: 50 }, (_, i) => `Alpha-${i}`)
    await expect(lookUpMany(names, new LookupBudget(1000), 1)).rejects.toBeInstanceOf(FatalApiError)
    expect(calls).toBe(3)
  })

  it('ten at a time: no worker starts another lookup once one has failed fatally', async () => {
    // The first lookup fails fatally at once; the nine started beside it succeed a moment
    // later. Without the stop, each of those nine would go on taking names until all fifty
    // were looked up, on a round already declared failed.
    let calls = 0
    webSearch.mockImplementation(async () => {
      const n = ++calls
      await new Promise(r => setTimeout(r, n === 1 ? 0 : 5))
      if (n === 1) throw FATAL()
      return good()
    })
    const names = Array.from({ length: 50 }, (_, i) => `Alpha-${i}`)
    await expect(lookUpMany(names, new LookupBudget(1000), 10)).rejects.toBeInstanceOf(FatalApiError)
    expect(calls).toBeLessThanOrEqual(10)
  })

  it('CONTROL: with no fatal failure the batch looks every name up', async () => {
    let calls = 0
    webSearch.mockImplementation(async () => { calls++; return good() })
    const names = Array.from({ length: 50 }, (_, i) => `Alpha-${i}`)
    const out = await lookUpMany(names, new LookupBudget(1000), 10)
    expect(calls).toBe(50)
    expect(out.every(r => r && !r.limited)).toBe(true)
  })
})
