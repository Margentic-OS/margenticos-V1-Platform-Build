// The per-caller web search budget.
//
// WHY THIS EXISTS. The reduction to one query capped at one search applies to the
// PER-PROSPECT path only. The ICP and positioning document agents share the same webSearch
// utility, run once per client rather than once per prospect, and are exactly where the
// richer search is worth paying for.
//
// Nothing in the type system stops a future edit from lowering WEB_SEARCH_MAX_USES instead
// of passing a per-call option, and that would silently degrade document generation to buy
// a saving that has nothing to do with it. The saving would still appear in the numbers,
// which is what makes it the dangerous kind of mistake. These tests pin the split.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const createMock = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: createMock }
  },
}))

/** One well-formed native response: a search ran and produced findings. */
function nativeResponse() {
  return {
    content: [
      { type: 'text', text: "I'll look into that." },
      { type: 'server_tool_use', id: 'x', name: 'web_search', input: {} },
      {
        type: 'web_search_tool_result',
        content: [
          { type: 'web_search_result', title: 'A', url: 'https://a.test' },
          { type: 'web_search_result', title: 'B', url: 'https://b.test' },
          { type: 'web_search_result', title: 'C', url: 'https://c.test' },
        ],
      },
      {
        type: 'text',
        text:
          '- Appeared on a podcast in March discussing operations.\n' +
          '- The company opened a second office and hired four people.\n' +
          '- Announced a new service line for mid-market clients.\n' +
          '- Published an article on pricing in a trade title.',
      },
    ],
  }
}

/** Every max_uses the SDK was actually asked for, in call order. */
function maxUsesRequested(): number[] {
  return createMock.mock.calls.map(([args]) => args.tools?.[0]?.max_uses)
}

beforeEach(() => {
  createMock.mockReset()
  createMock.mockResolvedValue(nativeResponse())
  process.env.ANTHROPIC_API_KEY = 'test-key'
  vi.resetModules()
})
afterEach(() => vi.restoreAllMocks())

describe('per-prospect research: ONE query, ONE search', () => {
  it('fires exactly one webSearch call per prospect', async () => {
    const { fetchWebSearchSource } = await import('../sources/web-search')

    await fetchWebSearchSource({
      first_name: 'Jane', last_name: 'Smith', company_name: 'Acme Consulting',
    } as never)

    // Was TWO before 2026-08-25: a person query and a company query in a Promise.all.
    expect(createMock).toHaveBeenCalledTimes(1)
  })

  it('caps that call at one billable search', async () => {
    const { fetchWebSearchSource } = await import('../sources/web-search')

    await fetchWebSearchSource({
      first_name: 'Jane', last_name: 'Smith', company_name: 'Acme Consulting',
    } as never)

    expect(maxUsesRequested()).toEqual([1])
  })

  it('THE POINT OF THE REDUCTION: worst case falls from 6 billable searches to 1', async () => {
    const { fetchWebSearchSource } = await import('../sources/web-search')

    await fetchWebSearchSource({
      first_name: 'Jane', last_name: 'Smith', company_name: 'Acme Consulting',
    } as never)

    const worstCase = maxUsesRequested().reduce((a, b) => a + b, 0)
    expect(worstCase).toBe(1)
    // Old shape: 2 queries x max_uses 3.
    expect(worstCase).toBeLessThan(2 * 3)
  })

  it('keeps BOTH halves of the category in the single query', async () => {
    // Cutting to one query must not silently drop person signals or company signals.
    // A podcast appearance and an incorporation were both named as things no other source
    // finds, so a merged query that covers only one of them defeats the reason for keeping
    // web search at all.
    const { fetchWebSearchSource } = await import('../sources/web-search')

    await fetchWebSearchSource({
      first_name: 'Jane', last_name: 'Smith', company_name: 'Acme Consulting',
    } as never)

    const sent = createMock.mock.calls[0][0].messages[0].content as string
    expect(sent).toContain('Jane Smith')
    expect(sent).toContain('Acme Consulting')
    for (const personSignal of ['podcast', 'interview', 'article']) {
      expect(sent.toLowerCase(), `person signal "${personSignal}" missing`).toContain(personSignal)
    }
    for (const companySignal of ['funding', 'incorporation', 'hiring']) {
      expect(sent.toLowerCase(), `company signal "${companySignal}" missing`).toContain(companySignal)
    }
  })

  it('still records spend and provenance from the one call', async () => {
    const { fetchWebSearchSource } = await import('../sources/web-search')

    const r = await fetchWebSearchSource({
      first_name: 'Jane', last_name: 'Smith', company_name: 'Acme Consulting',
    } as never)

    // A query that ran, cost money and returned nothing is the case worth counting, so
    // these must survive the reduction.
    expect(r.search_count).toBe(1)
    expect(r.result_count).toBe(3)
    expect(r.providers).toEqual(['anthropic_native'])
    expect(r.available).toBe(true)
  })
})

describe('document generation keeps the richer search, untouched', () => {
  it('runResearchQueries uses the DEFAULT budget, not the per-prospect one', async () => {
    const { runResearchQueries, WEB_SEARCH_MAX_USES } = await import('../../tools/webSearch')

    await runResearchQueries(['market size', 'buyer pains', 'competitors', 'pricing'])

    // Four queries, each at the default cap. If a future edit "optimises" by lowering the
    // constant, this fails and says why.
    expect(createMock).toHaveBeenCalledTimes(4)
    expect(maxUsesRequested()).toEqual([
      WEB_SEARCH_MAX_USES, WEB_SEARCH_MAX_USES, WEB_SEARCH_MAX_USES, WEB_SEARCH_MAX_USES,
    ])
    expect(WEB_SEARCH_MAX_USES).toBe(3)
  })

  it('the two paths genuinely differ, which is the whole point', async () => {
    const { webSearch, WEB_SEARCH_MAX_USES } = await import('../../tools/webSearch')

    await webSearch('a document-agent style query')
    await webSearch('a prospect-research style query', { maxUses: 1 })

    expect(maxUsesRequested()).toEqual([WEB_SEARCH_MAX_USES, 1])
  })
})
