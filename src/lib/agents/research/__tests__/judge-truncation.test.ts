// A CUT-OFF ANSWER IS A FAILURE WITH A NAME, NOT A QUIET NON-GRADE.
//
// The JSON is the last thing the judge writes, so an answer that hits the output ceiling always
// loses it. Three of 39 calls did exactly that on 2026-09-11, once the judge began reading each
// fit dimension with a quotation, and each one recorded "Claude returned non-JSON", which reads
// like a model error rather than an answer we cut off ourselves.

import { describe, it, expect, vi } from 'vitest'
import type { Message } from '@anthropic-ai/sdk/resources/messages'

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { buildSynthesisParams, synthesisFromMessage, type ClientDocContext, type DetectedSignal } from '../synthesize'
import type { ProspectContext, RawSourceData } from '../types'

const SOURCES = {
  linkedin: { available: false, profile_data: null, recent_posts: null, formatted: null },
  apollo: { available: false, formatted: null, raw: null },
  website: { available: false, url: null, content: null, fetch_method: null },
  web_search: { available: false, person_search: null, company_search: null, combined: null },
} as unknown as RawSourceData
const SIGNAL: DetectedSignal = { has_dateable_signal: false, signal_observation: null }
const CLIENT_CTX: ClientDocContext = {
  clientName: 'Placeholder Client', buyerTitle: null, icpSummary: 'Placeholder summary',
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
