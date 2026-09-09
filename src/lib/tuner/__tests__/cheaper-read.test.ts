// Reading less to reach the same verdict.
//
// ─── WHAT WAS MEASURED, SO THESE ASSERTIONS ARE NOT ARBITRARY ────────────────
//
// 2026-09-09, 40 paired lookups on one live client, the old read and the new read over the
// SAME companies:
//
//                        billable searches   input tokens   batch of 80
//   old (4-6 bullets)          1.48             9,637          $2.22
//   new (one question)         1.00             9,619          $1.77
//
// The search count fell by a third and the page text did not move at all, which is the whole
// finding: the provider decides how much page arrives and no parameter changes it, so the
// only reachable saving was in how many times it arrived.

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'

const create = vi.hoisted(() => vi.fn())
// Only the CLIENT is replaced. The module also exports the error classes that
// fatal-api-error.ts does instanceof checks against, and a mock that drops them turns every
// failure path into a TypeError from inside the error handler rather than the behaviour
// under test.
vi.mock('@anthropic-ai/sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  default: class { messages = { create } },
}))

import { webSearch } from '@/lib/agents/tools/webSearch'
import { buildLookupQuery } from '@/lib/tuner/lookup'

// The native path checks for a key before it builds a client, and without one every case
// here would silently fall through to the fallback and assert against a result the code
// under test never produced. The value is never sent anywhere: the client is a stub.
beforeAll(() => { process.env.ANTHROPIC_API_KEY = 'test-key-not-a-credential' })

afterEach(() => { create.mockReset() })

/** A response shaped the way the server-side search tool actually returns one. */
const searchResponse = (synthesis: string, searches = 1) => ({
  model: 'claude-haiku-4-5-20251001',
  usage: { input_tokens: 9600, output_tokens: 150 },
  content: [
    ...Array.from({ length: searches }, () => ({
      type: 'web_search_tool_result',
      content: [{ title: 'a result' }, { title: 'another' }],
    })),
    { type: 'text', text: synthesis },
  ],
})

// A PLACEHOLDER, deliberately naming no sector, product or buyer. This file is about how
// much is read, not about what is read, so the content only has to be long enough to clear
// the usability floor.
const USABLE = 'Placeholder Org sells a placeholder offering to placeholder buyers, who use it '
  + 'for a placeholder purpose, and this sentence exists only to clear the length floor.'

describe('the brief read asks for one search and one answer', () => {
  it('sends a different instruction, and it is the one that forbids a second search', async () => {
    create.mockResolvedValue(searchResponse(USABLE))
    await webSearch('anything', { maxUses: 1, brief: true })

    const sent = create.mock.calls[0][0].messages[0].content as string
    expect(sent).toContain('Use ONE search')
    expect(sent).toContain('do not search again')
    // The default framing asks for a list, which is an invitation to keep searching until
    // the list is full. Brief must not carry it.
    expect(sent).not.toContain('4–6 concise bullet points')
  })

  it('caps the answer shorter than the default', async () => {
    create.mockResolvedValue(searchResponse(USABLE))
    await webSearch('anything', { brief: true })
    const brief = create.mock.calls[0][0].max_tokens

    create.mockClear()
    await webSearch('anything')
    const normal = create.mock.calls[0][0].max_tokens

    expect(brief).toBeLessThan(normal)
  })

  it('leaves the default framing untouched for callers that did not ask', async () => {
    // The document agents run four queries ONCE per client and richer search is worth paying
    // for there. Narrowing them to buy a per-prospect saving would be a change nobody asked
    // for, on a path where the saving does not exist.
    create.mockResolvedValue(searchResponse(USABLE))
    await webSearch('anything')

    const sent = create.mock.calls[0][0].messages[0].content as string
    expect(sent).toContain('4–6 concise bullet points')
    expect(sent).not.toContain('Use ONE search')
  })
})

describe('a lookup that gave up is not a lookup that answered', () => {
  it('marks the explicit non-answer as limited', async () => {
    create.mockResolvedValue(searchResponse('UNKNOWN'))
    const r = await webSearch('anything', { brief: true })

    expect(r.limited).toBe(true)
    expect(r.limitedReason).toContain('did not answer')
  })

  it('does not read the same word as a non-answer when brief was not asked for', async () => {
    // Only brief mode offers the sentinel, so only brief mode may honour it. Reading it
    // anywhere would let an ordinary search result be discarded for its first word.
    create.mockResolvedValue(searchResponse('UNKNOWN'))
    const r = await webSearch('anything')
    expect(r.limitedReason).not.toContain('did not answer')
  })

  it('still reports a real answer as usable', async () => {
    create.mockResolvedValue(searchResponse(USABLE))
    const r = await webSearch('anything', { brief: true })
    expect(r.limited).toBe(false)
    expect(r.synthesis).toBe(USABLE)
  })
})

describe('the cost the API returned is carried out, not discarded', () => {
  it('reports input and output tokens and the model billed', async () => {
    create.mockResolvedValue(searchResponse(USABLE))
    const r = await webSearch('anything', { brief: true })

    // These three were computed by the API on every call and thrown away here for months,
    // which is why the project costed the search fee alone.
    expect(r.inputTokens).toBe(9600)
    expect(r.outputTokens).toBe(150)
    expect(r.model).toBe('claude-haiku-4-5-20251001')
  })
})

describe('the lookup asks one question, not three', () => {
  it('no longer asks what the organisation does, sells AND who buys, in one breath', () => {
    const q = buildLookupQuery('Placeholder Org')
    expect(q).toContain('Placeholder Org')
    // Three questions is what produced 1.48 searches per lookup against a requested cap of 1.
    expect(q.match(/\?/g) ?? []).toHaveLength(1)
    expect(q).not.toContain('what does it do')
  })
})
