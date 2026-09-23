// A CUT-OFF ANSWER IS A FAILURE WITH A NAME, NOT A QUIET NON-GRADE.
//
// The JSON is the last thing the judge writes, so an answer that hits the output ceiling always
// loses it. Three of 39 calls did exactly that on 2026-09-11, once the judge began reading each
// fit dimension with a quotation, and each one recorded "Claude returned non-JSON", which reads
// like a model error rather than an answer we cut off ourselves.

import { describe, it, expect, vi } from 'vitest'
import type { Message } from '@anthropic-ai/sdk/resources/messages'

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import {
  buildSynthesisParams, synthesisFromMessage,
  wasTruncated, truncationReason, retryTruncatedSynthesis,
  CONSTRAINED_REASONING_INSTRUCTION, SYNTHESIS_MAX_OUTPUT_TOKENS,
  type ClientDocContext, type DetectedSignal,
} from '../synthesize'
import type { ProspectContext, RawSourceData } from '../types'

const SOURCES = {
  linkedin: { available: false, profile_data: null, recent_posts: null, formatted: null },
  apollo: { available: false, formatted: null, raw: null },
  website: { available: false, url: null, content: null, fetch_method: null },
  web_search: { available: false, person_search: null, company_search: null, combined: null },
} as unknown as RawSourceData
const SIGNAL: DetectedSignal = { has_dateable_signal: false, signal_observation: null }
const CLIENT_CTX: ClientDocContext = {
  // triggers empty: this fixture's client has none, so relevance falls back to push
  // forces, which is what this test was written against.
  clientName: 'Placeholder Client', buyerTitle: null, triggers: [], icpSummary: 'Placeholder summary',
  positioningSummary: 'Placeholder positioning', valuePropContext: 'Placeholder value', tovRules: 'Placeholder rules',
}
const PROSPECT = {
  id: 'p-1', organisation_id: 'org-1', segment_id: null, first_name: 'Placeholder', last_name: 'Person',
  company_name: 'Placeholder Company', country: null, role: null, job_title: 'Placeholder Title',
  email: null, linkedin_url: null, website_url: null, company: null,
} as ProspectContext

function message(text: string, over: Partial<Message> = {}): Message {
  return {
    id: 'msg', type: 'message', role: 'assistant', model: 'placeholder-model',
    content: [{ type: 'text', text, citations: null }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 24000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ...over,
  } as unknown as Message
}

const COMPLETE_ANSWER = `<reasoning>placeholder</reasoning>\n${JSON.stringify({ icp_fit: 'strong', candidates: [] })}`

describe('the ceiling leaves room for the dimension readings', () => {
  it('asks for more than the 16,000 tokens that truncated real answers', () => {
    expect(buildSynthesisParams(PROSPECT, SOURCES, CLIENT_CTX, SIGNAL).max_tokens).toBeGreaterThanOrEqual(24_000)
  })

  it('asks for the same on the batch path, which builds the same request', () => {
    expect(buildSynthesisParams(PROSPECT, SOURCES, CLIENT_CTX, SIGNAL, '1h').max_tokens)
      .toBe(buildSynthesisParams(PROSPECT, SOURCES, CLIENT_CTX, SIGNAL, '5m').max_tokens)
  })
})

describe('an answer cut off at the ceiling records that, and no grade', () => {
  const truncated = () => synthesisFromMessage(
    message(COMPLETE_ANSWER, { stop_reason: 'max_tokens' }), PROSPECT, CLIENT_CTX, SIGNAL, SOURCES,
  )

  it('names the ceiling and the tokens it ran to, rather than blaming the JSON', () => {
    const out = truncated()
    expect(out.icp_fit).toBe('cannot_tell')
    expect(out.icp_fit_missing).toMatch(/cut off/i)
    expect(out.icp_fit_missing).toContain('24000')
    expect(out.icp_fit_missing).not.toMatch(/non-JSON/)
  })

  it('records it where the research row keeps it, so it survives the run', () => {
    expect(truncated().relevance_reason).toMatch(/cut off/i)
  })

  it('refuses the answer even when what arrived happens to parse', () => {
    // The text above is complete and says strong. The answer was still cut off, so the rest of
    // it, including the candidates, is missing and the grade is not ours to take.
    expect(truncated().icp_fit).not.toBe('strong')
    expect(truncated().candidates).toEqual([])
  })

  it('still reports what the call cost', () => {
    expect(truncated().usage.output_tokens).toBe(24000)
  })

  it('leaves an answer that finished alone', () => {
    const out = synthesisFromMessage(message(COMPLETE_ANSWER), PROSPECT, CLIENT_CTX, SIGNAL, SOURCES)
    expect(out.icp_fit).toBe('strong')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// ONE RETRY, WITH THE REASONING CONSTRAINED
//
// Added 2026-09-15. A truncated answer used to return the fallback immediately, so a full
// ceiling of output tokens was billed and the approved template shipped. Measured on the
// 2026-09-14 batch: 2 of 7 entries, roughly $0.20 of batch-rate output each, 44% of that
// batch's synthesis spend, all discarded.

describe('the retry instruction goes where it does not break the cache', () => {
  const plain    = buildSynthesisParams(PROSPECT, SOURCES, CLIENT_CTX, SIGNAL, '5m')
  const retrying = buildSynthesisParams(PROSPECT, SOURCES, CLIENT_CTX, SIGNAL, '5m', true)

  const systemText = (p: ReturnType<typeof buildSynthesisParams>) =>
    JSON.stringify(p.system)
  const userText = (p: ReturnType<typeof buildSynthesisParams>) =>
    JSON.stringify(p.messages)

  it('leaves the cached system prefix byte-identical', () => {
    // The system prompt is roughly 8,500 cached tokens read by every prospect in a batch.
    // Putting the instruction there would make the retry miss the cache AND write a second
    // entry nothing else reads.
    expect(systemText(retrying)).toBe(systemText(plain))
  })

  it('puts the instruction in the user message instead', () => {
    expect(userText(retrying)).not.toBe(userText(plain))
    expect(userText(retrying)).toContain('cut off before its JSON arrived')
  })

  it('tells the model which half to sacrifice, and it is never the JSON', () => {
    expect(CONSTRAINED_REASONING_INSTRUCTION).toMatch(/shorten the reasoning/i)
    expect(CONSTRAINED_REASONING_INSTRUCTION).toMatch(/Never shorten or omit the JSON/i)
  })

  it('does not lower the ceiling, because the ceiling is not the problem', () => {
    expect(retrying.max_tokens).toBe(plain.max_tokens)
    expect(retrying.max_tokens).toBe(SYNTHESIS_MAX_OUTPUT_TOKENS)
  })

  it('names the real ceiling in the instruction, from the same constant the request uses', () => {
    // A hardcoded number here would be a second copy, and it would go stale the next time
    // the ceiling moves, telling the model it hit a limit that no longer exists.
    expect(CONSTRAINED_REASONING_INSTRUCTION).toContain(
      SYNTHESIS_MAX_OUTPUT_TOKENS.toLocaleString('en-US'),
    )
  })

  it('is off by default, so every existing caller sends the bytes it always sent', () => {
    expect(userText(buildSynthesisParams(PROSPECT, SOURCES, CLIENT_CTX, SIGNAL)))
      .toBe(userText(plain))
  })
})

describe('wasTruncated is the one verdict three call sites share', () => {
  it('is true only at the ceiling', () => {
    expect(wasTruncated(message(COMPLETE_ANSWER, { stop_reason: 'max_tokens' }))).toBe(true)
    expect(wasTruncated(message(COMPLETE_ANSWER, { stop_reason: 'end_turn' }))).toBe(false)
    expect(wasTruncated(message(COMPLETE_ANSWER, { stop_reason: 'stop_sequence' }))).toBe(false)
  })

  it('names the token count in the reason, so the waste can be costed later', () => {
    expect(truncationReason(24000)).toContain('24000')
    expect(truncationReason(24000)).toMatch(/cut off at the output ceiling/i)
  })
})

describe('retryTruncatedSynthesis: once, and it keeps what the discarded call cost', () => {
  const anthropic = (responses: Message[]) => {
    const calls: unknown[] = []
    let i = 0
    return {
      calls,
      client: {
        messages: {
          // STREAMS, AND REFUSES create(). Synthesis moved to messages.stream on
          // 2026-09-21: the SDK rejects a non-streaming call at the 24,000-token ceiling
          // outright. The fake THROWS on create rather than implementing both, because a
          // fake that quietly answers a call production no longer makes cannot tell you
          // when the code goes back to making it.
          stream: (params: unknown) => {
            calls.push(params)
            const response = responses[i++]
            return { finalMessage: async () => response }
          },
          create: async () => {
            throw new Error('fake: synthesis must call messages.stream, not messages.create')
          },
        },
      } as never,
    }
  }

  it('sends the constrained instruction on the retry', async () => {
    const { client, calls } = anthropic([message(COMPLETE_ANSWER)])
    await retryTruncatedSynthesis(client, PROSPECT, SOURCES, CLIENT_CTX, SIGNAL)
    expect(calls).toHaveLength(1)
    expect(JSON.stringify(calls[0])).toContain('cut off before its JSON arrived')
  })

  it('returns a retry that truncated AGAIN, so the caller can still read its usage', async () => {
    // Returning null here would lose the second call's tokens, and the second call was billed.
    const { client } = anthropic([message(COMPLETE_ANSWER, { stop_reason: 'max_tokens' })])
    const out = await retryTruncatedSynthesis(client, PROSPECT, SOURCES, CLIENT_CTX, SIGNAL)
    expect(out).not.toBeNull()
    expect(wasTruncated(out as Message)).toBe(true)
  })

  it('returns null only when the retry could not be made at all', async () => {
    const client = {
      // Throws from stream(), the call the code actually makes. Before this was updated
      // it threw from create() and the test still passed, because `stream` being
      // undefined produced a TypeError that looked identical from the outside: a case
      // passing for the wrong reason and proving nothing.
      messages: { stream: () => { throw new Error('network gone') } },
    } as never
    expect(await retryTruncatedSynthesis(client, PROSPECT, SOURCES, CLIENT_CTX, SIGNAL)).toBeNull()
  })
})
