// ARM C REACHES THE PROVIDER, which is the one thing the other arm tests cannot check.
//
// ═══ WHY THIS FILE EXISTS ════════════════════════════════════════════════════
//
// cost-arms.test.ts proves briefWebSearch() returns the right boolean. That says nothing about
// whether the boolean reaches the API, and the failure mode is silent in the worst direction: a
// run labelled arm-c that never switched brief on records a saving of zero, which reads as
// "brief mode does not work" when what happened is that brief mode never ran.
//
// So this drives fetchWebSearchSource with the SDK mocked and inspects the request the provider
// would have received.
//
// WHAT BRIEF MODE IS, measured in the tuner over 40 paired lookups (docs/tuner-cost.md):
//   billable searches   1.48 -> 1.00      the whole of the saving
//   input tokens        9,637 -> 9,619    no change at all
// It cuts how many search blocks arrive, not how big each one is. There is no parameter at any
// price that shrinks the injected page text.
//
// RULE ZERO. Every fixture is invented and industry-neutral.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const sdk = { created: [] as Record<string, unknown>[] }

vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    messages = {
      create: async (params: Record<string, unknown>) => {
        sdk.created.push(params)
        // A REALISTIC RESPONSE, not a minimal one. The first version returned a bare text
        // block, and the native reader treated that as a failure and fell through to the
        // Brave path, which hardcodes inputTokens: 0. The test then reported zero tokens and
        // looked like a token-plumbing bug when it was a fixture bug. A tool_result block and
        // a model are what make this the native path.
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
          usage: { input_tokens: 9487, output_tokens: 368 },
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

/** The tool definition the request carried, whatever shape the SDK params take. */
function toolOf(params: Record<string, unknown>): Record<string, unknown> {
  const tools = (params.tools ?? []) as Record<string, unknown>[]
  const t = tools.find(x => String(x.name ?? '').includes('search'))
  if (!t) throw new Error('no web_search tool in the request')
  return t
}

beforeEach(() => {
  sdk.created.length = 0
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test')
  vi.stubEnv('ARM_BRIEF_WEB_SEARCH', '')
})
afterEach(() => { vi.unstubAllEnvs() })

describe('arm C off: the request is what production sends today', () => {
  it('still carries the web_search tool with a max_uses of 1', async () => {
    await fetchWebSearchSource(PROSPECT)
    expect(sdk.created).toHaveLength(1)
    expect(toolOf(sdk.created[0]).max_uses).toBe(1)
  })

  it('does NOT carry the brief output ceiling', async () => {
    // Brief mode drops max_tokens to 200. Off, it must be the ordinary ceiling.
    await fetchWebSearchSource(PROSPECT)
    expect(sdk.created[0].max_tokens).not.toBe(200)
  })
})

describe('arm C on: brief mode reaches the request', () => {
  it('applies the brief output ceiling', async () => {
    vi.stubEnv('ARM_BRIEF_WEB_SEARCH', 'true')
    await fetchWebSearchSource(PROSPECT)
    expect(sdk.created[0].max_tokens).toBe(200)
  })

  it('changes the prompt, which is where the search count is actually cut', async () => {
    // The saving comes from asking one question and telling the model to answer from the first
    // result set, not from the cap. A brief request whose prompt matched the default would be
    // the arm silently not running.
    vi.stubEnv('ARM_BRIEF_WEB_SEARCH', '')
    await fetchWebSearchSource(PROSPECT)
    const plain = JSON.stringify(sdk.created[0].messages)

    sdk.created.length = 0
    vi.stubEnv('ARM_BRIEF_WEB_SEARCH', 'true')
    await fetchWebSearchSource(PROSPECT)
    const brief = JSON.stringify(sdk.created[0].messages)

    expect(brief).not.toBe(plain)
  })

  it('still sends exactly ONE request, so the arm cannot be a hidden extra call', async () => {
    vi.stubEnv('ARM_BRIEF_WEB_SEARCH', 'true')
    await fetchWebSearchSource(PROSPECT)
    expect(sdk.created).toHaveLength(1)
  })
})

describe('the token fields survive, because they are half the bill', () => {
  it('returns the input and output tokens the call reported', async () => {
    // The fee was 57% of a lookup and these tokens the other 43%. They were computed and
    // discarded on this path until 2026-09-25.
    const r = await fetchWebSearchSource(PROSPECT)
    expect(r.input_tokens).toBe(9487)
    expect(r.output_tokens).toBe(368)
    expect(r.model).toBeTruthy()
  })

  it('returns them with brief on too, so the arm can be priced', async () => {
    vi.stubEnv('ARM_BRIEF_WEB_SEARCH', 'true')
    const r = await fetchWebSearchSource(PROSPECT)
    expect(r.input_tokens).toBe(9487)
    expect(r.output_tokens).toBe(368)
  })
})
