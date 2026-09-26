// BRIEF WEB SEARCH IS UNCONDITIONAL ON THE RESEARCH PATH.
//
// ═══ WHAT THIS GUARDS, AND WHY IT IS NOT A FLAG TEST ═════════════════════════
//
// Adopted 2026-09-26 from a paired measurement over 40 prospects, each compared against its own
// stored search count from when brief was off:
//
//   billable searches   2.25 -> 1.00      a 56% cut, 30 of 40 prospects down
//   input tokens        unchanged at 10,192
//   personalised rate   75.0% against the control's 62.5%
//
// It was a flag for exactly one day. The flag is gone on purpose: a setting left switchable
// after it is adopted is one somebody turns off while debugging and forgets, and the
// 2.83-searches-per-prospect world it would silently restore is the one the measurement exists
// to leave behind. So the test is not "the flag works", it is "there is no way to turn this off".
//
// THE SAVING IS FEES, NOT TOKENS, and the second block asserts that rather than hoping for it.
// Nothing shrinks the page text the provider injects; brief mode cuts how many search blocks
// arrive. A future change that reduced input tokens instead would mean something else happened.
//
// RULE ZERO. Every fixture is invented and industry-neutral.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const sdk = { created: [] as Record<string, unknown>[] }

vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    messages = {
      create: async (params: Record<string, unknown>) => {
        sdk.created.push(params)
        return {
          model: 'claude-haiku-4-5-20251001',
          stop_reason: 'end_turn',
          content: [
            { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'placeholder' } },
            {
              type: 'web_search_tool_result',
              tool_use_id: 'srvtoolu_1',
              content: [
                { type: 'web_search_result', title: 'Placeholder announcement', url: 'https://placeholder.example/news', page_age: null },
                { type: 'web_search_result', title: 'Placeholder interview', url: 'https://placeholder.example/podcast', page_age: null },
                { type: 'web_search_result', title: 'Placeholder article', url: 'https://placeholder.example/post', page_age: null },
              ],
            },
            { type: 'text', text: 'The placeholder company announced a new office in the placeholder month.' },
          ],
          usage: { input_tokens: 10192, output_tokens: 100 },
        }
      },
    }
    constructor(_o: Record<string, unknown>) {}
  }
  return { default: Anthropic }
})
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { fetchWebSearchSource } = await import('../sources/web-search')

const PROSPECT = {
  id: 'p-1', organisation_id: 'org-1', segment_id: null,
  first_name: 'Placeholder', last_name: 'Person', company_name: 'Placeholder Company',
  role: null, job_title: 'Placeholder Title', email: null, linkedin_url: null,
  website_url: null, company: null,
} as never

/** Brief mode's output ceiling, which is how the request shows brief was applied. */
const BRIEF_MAX_TOKENS = 200

beforeEach(() => {
  sdk.created.length = 0
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test')
})
afterEach(() => { vi.unstubAllEnvs() })

describe('brief mode applies with no configuration at all', () => {
  it('sends the brief output ceiling on a plain call', async () => {
    await fetchWebSearchSource(PROSPECT)
    expect(sdk.created).toHaveLength(1)
    expect(sdk.created[0].max_tokens).toBe(BRIEF_MAX_TOKENS)
  })

  it('still caps the request at one search', async () => {
    const tools = (sdk.created[0]?.tools ?? []) as Record<string, unknown>[]
    await fetchWebSearchSource(PROSPECT)
    const t = ((sdk.created[0].tools ?? []) as Record<string, unknown>[])
      .find(x => String(x.name ?? '').includes('search'))
    expect(t?.max_uses).toBe(1)
    void tools
  })

  it('makes exactly ONE request, so brief is not a second call in disguise', async () => {
    await fetchWebSearchSource(PROSPECT)
    expect(sdk.created).toHaveLength(1)
  })
})

describe('no environment variable can switch it off', () => {
  // The control in the other direction. If any of these turned brief off, the 2.83-search
  // behaviour would return silently and the only symptom would be the bill.
  it.each([
    'ARM_BRIEF_WEB_SEARCH', 'BRIEF_WEB_SEARCH', 'WEB_SEARCH_BRIEF', 'RESEARCH_BRIEF_SEARCH',
  ])('stays on with %s set to false', async name => {
    vi.stubEnv(name, 'false')
    await fetchWebSearchSource(PROSPECT)
    expect(sdk.created[0].max_tokens).toBe(BRIEF_MAX_TOKENS)
  })
})

describe('the saving is the search count, not the page text', () => {
  it('still reports the input tokens the provider billed', async () => {
    // Measured unchanged at 10,192 with brief on. If a future change made this fall, the cause
    // is not brief mode and the cost model should not be told it was.
    const r = await fetchWebSearchSource(PROSPECT)
    expect(r.input_tokens).toBe(10192)
    expect(r.model).toBeTruthy()
  })

  it('counts the billable searches, which is the line brief mode actually moves', async () => {
    const r = await fetchWebSearchSource(PROSPECT)
    expect(r.search_count).toBe(1)
  })
})

describe('the arm switches are gone from the tree, not merely unused', () => {
  it('has no cost-arms module left to import', () => {
    expect(fs.existsSync(path.join(process.cwd(), 'src/lib/agents/research/cost-arms.ts'))).toBe(false)
  })

  it('leaves no reference to the rejected arms in the source', () => {
    // A leftover import would still compile if the module came back, and a leftover env read is
    // how a deleted arm returns as a live switch.
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/lib/agents/research/sources/web-search.ts'), 'utf8')
    expect(src).toContain('brief: true')          // positive control: the file is the right one
    expect(src).not.toMatch(/briefWebSearch\s*\(/)
    const syn = fs.readFileSync(
      path.join(process.cwd(), 'src/lib/agents/research/synthesize.ts'), 'utf8')
    expect(syn).toContain('SYNTHESIS_MODEL')      // positive control
    expect(syn).not.toMatch(/candidateCap\s*\(/)
    expect(syn).not.toMatch(/synthesisModelOverride\s*\(/)
  })
})
