// The claim the whole batch change rests on: splitting the synthesis call in two does
// not change a single byte of what the model sees, or a single field of what comes back.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS IS MOSTLY STRUCTURAL AND ONLY PARTLY A TEST
//
// synthesizeResearch is now DEFINED in terms of buildSynthesisRequest and
// synthesisFromMessage. The batch path calls those same two functions. There is one
// implementation of each, so "the two paths agree" is not a property a test has to keep
// checking: it cannot be false without the inline path changing too.
//
// What a test CAN add, and what these do, is guard the properties that would break that
// equivalence from underneath:
//
//   1. buildSynthesisParams must be PURE. If a clock, a uuid or an unordered key ever
//      leaks in, two calls diverge, a resubmission after a batch expiry sends different
//      bytes, and the prompt cache misses.
//   2. The 1-hour TTL must change ONLY cache_control. If it ever altered the prompt, the
//      batch would be sending different input to the model and "no quality trade" would
//      be false.
//   3. synthesisFromMessage must be PURE and clock-independent. Phase 2 runs up to 24
//      hours after phase 1; anything time-dependent in the parse would make the verdict
//      depend on when the batch happened to finish.
//   4. The cached prefix must be identical across prospects in one client, or batching
//      buys the discount and loses the caching.

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { Message } from '@anthropic-ai/sdk/resources/messages'
import {
  buildSynthesisParams,
  synthesisFromMessage,
  type ClientDocContext,
  type DetectedSignal,
} from '../synthesize'
import type { ProspectContext, RawSourceData } from '../types'

const CLIENT_CTX: ClientDocContext = {
  clientName:         'Northwind Advisory',
  icpSummary:         'Their ideal client: operations lead at growth stage.',
  positioningSummary: 'They shorten the gap between a signed contract and a working system.',
  valuePropContext:   'Core pain solved: "projects stall between sale and delivery"',
  tovRules:           'Plain, specific, no hype.',
}

const SIGNAL: DetectedSignal = {
  has_dateable_signal: true,
  signal_observation:  'LinkedIn post 2026-08-20: opened a second delivery pod',
}

function prospect(overrides: Partial<ProspectContext> = {}): ProspectContext {
  return {
    id: 'p-1',
    organisation_id: 'org-1',
    segment_id: 'seg-1',
    first_name: 'Ada',
    last_name: 'Okoro',
    company_name: 'Meridian Systems',
    role: 'Head of Delivery',
    email: 'ada@example.com',
    linkedin_url: 'https://www.linkedin.com/in/example',
    website_url: 'https://example.com',
    ...overrides,
  }
}

function sources(): RawSourceData {
  return {
    linkedin:  { available: true, profile_data: null, recent_posts: [], formatted: 'Posted about a second delivery pod.', error: undefined },
    apollo:    { available: true, formatted: 'Head of Delivery since 2024.', raw: null, error: undefined },
    website:   { available: true, url: 'https://example.com', content: 'We build delivery systems.', fetch_method: 'fetch', error: undefined },
    web_search: {
      available: true, person_search: null, company_search: null,
      combined: 'Meridian Systems opened a second pod in August.',
      error: undefined, providers: ['brave'], search_count: 1, result_count: 3,
    },
  } as unknown as RawSourceData
}

function message(text: string, overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 120,
      output_tokens: 6200,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 6700,
    },
    ...overrides,
  } as unknown as Message
}

const RESPONSE = `<reasoning>
The second pod is the strongest dated signal.
</reasoning>
{
  "icp_fit": "strong",
  "qualification_status": "qualified",
  "confidence": "high",
  "relevance_reason": "Recent, dated, and specific to delivery capacity.",
  "trigger_text": "Meridian opened a second delivery pod in August.",
  "selected_candidate_id": "c1",
  "candidates": [
    {
      "id": "c1",
      "observation": "Meridian opened a second delivery pod in August.",
      "source": "web_search",
      "provenance": "https://example.com/news/second-pod",
      "date": "2026-08-20",
      "scores": { "specific": true, "recent": true, "verifiable": true, "consequential": true, "non_obvious": true, "actionable": true },
      "passes_all": true,
      "score_total": 6,
      "opposite_reading": "They may simply be reorganising existing staff.",
      "inference_direction": "stated"
    }
  ]
}`

afterEach(() => { vi.useRealTimers() })

describe('buildSynthesisParams is pure, which is what makes a resubmission reproducible', () => {
  it('produces byte-identical params on repeated calls', () => {
    const a = buildSynthesisParams(prospect(), sources(), CLIENT_CTX, SIGNAL)
    const b = buildSynthesisParams(prospect(), sources(), CLIENT_CTX, SIGNAL)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('does not depend on the wall clock', () => {
    // A batch that expires is resubmitted from the stored snapshot up to 24 hours later.
    // If a date leaked into the prompt, the resubmission would send different bytes,
    // miss the cache, and could reach a different verdict.
    const a = buildSynthesisParams(prospect(), sources(), CLIENT_CTX, SIGNAL)
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2027-03-04T11:22:33Z'))
    const b = buildSynthesisParams(prospect(), sources(), CLIENT_CTX, SIGNAL)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

describe('the 1-hour TTL changes the cache directive and NOTHING the model reads', () => {
  it('sends an identical system prompt, user message, model and max_tokens', () => {
    const live  = buildSynthesisParams(prospect(), sources(), CLIENT_CTX, SIGNAL, '5m')
    const batch = buildSynthesisParams(prospect(), sources(), CLIENT_CTX, SIGNAL, '1h')

    expect(batch.model).toBe(live.model)
    expect(batch.max_tokens).toBe(live.max_tokens)
    expect(batch.messages).toEqual(live.messages)

    const liveSystem  = live.system  as Array<{ text: string; cache_control?: unknown }>
    const batchSystem = batch.system as Array<{ text: string; cache_control?: unknown }>
    // THE BYTES THE MODEL SEES. This is the assertion behind "no quality trade".
    expect(batchSystem[0].text).toBe(liveSystem[0].text)
  })

  it('differs ONLY in cache_control, and only by the ttl field', () => {
    const live  = buildSynthesisParams(prospect(), sources(), CLIENT_CTX, SIGNAL, '5m')
    const batch = buildSynthesisParams(prospect(), sources(), CLIENT_CTX, SIGNAL, '1h')

    expect((live.system as Array<{ cache_control: unknown }>)[0].cache_control)
      .toEqual({ type: 'ephemeral' })
    expect((batch.system as Array<{ cache_control: unknown }>)[0].cache_control)
      .toEqual({ type: 'ephemeral', ttl: '1h' })

    // And nothing else moved. Strip cache_control from both and they are the same object.
    const strip = (p: ReturnType<typeof buildSynthesisParams>) => JSON.stringify({
      ...p,
      system: (p.system as Array<{ text: string }>).map(b => ({ type: 'text', text: b.text })),
    })
    expect(strip(batch)).toBe(strip(live))
  })

  it('defaults to the 5-minute cache, so the LIVE path is unchanged by this refactor', () => {
    const defaulted = buildSynthesisParams(prospect(), sources(), CLIENT_CTX, SIGNAL)
    expect((defaulted.system as Array<{ cache_control: unknown }>)[0].cache_control)
      .toEqual({ type: 'ephemeral' })
  })
})

describe('the cached prefix is shared across prospects, which is why batching pays', () => {
  it('two different prospects in one client get a byte-identical system prompt', () => {
    // If a per-prospect value ever leaks into the system block, cache_read_input_tokens
    // goes to zero across a whole batch and nothing else says so.
    const a = buildSynthesisParams(prospect({ id: 'p-1', first_name: 'Ada' }), sources(), CLIENT_CTX, SIGNAL)
    const b = buildSynthesisParams(prospect({ id: 'p-2', first_name: 'Bo', company_name: 'Other Co' }), sources(), CLIENT_CTX, SIGNAL)

    const textOf = (p: ReturnType<typeof buildSynthesisParams>) =>
      (p.system as Array<{ text: string }>)[0].text

    expect(textOf(a)).toBe(textOf(b))
    // ...and the per-prospect content really is in the user message, not merely absent.
    expect(JSON.stringify(a.messages)).not.toBe(JSON.stringify(b.messages))
    expect(JSON.stringify(a.messages)).toContain('Ada')
    expect(textOf(a)).not.toContain('Ada')
  })
})

describe('synthesisFromMessage is pure, so phase 2 reaches phase 1 verdicts', () => {
  it('returns a deep-equal result when called twice on the same Message', () => {
    const a = synthesisFromMessage(message(RESPONSE), prospect(), CLIENT_CTX, SIGNAL)
    const b = synthesisFromMessage(message(RESPONSE), prospect(), CLIENT_CTX, SIGNAL)
    expect(a).toEqual(b)
  })

  it('reaches the same verdict 24 hours later, which is the actual batch scenario', () => {
    const atSubmit = synthesisFromMessage(message(RESPONSE), prospect(), CLIENT_CTX, SIGNAL)

    vi.useFakeTimers()
    vi.setSystemTime(new Date('2027-01-01T00:00:00Z'))
    const atCollect = synthesisFromMessage(message(RESPONSE), prospect(), CLIENT_CTX, SIGNAL)

    expect(atCollect).toEqual(atSubmit)
    // Named explicitly, because these are the fields that reach the prospect's row.
    expect(atCollect.icp_fit).toBe(atSubmit.icp_fit)
    expect(atCollect.selected_candidate_id).toBe(atSubmit.selected_candidate_id)
    expect(atCollect.trigger_text).toBe(atSubmit.trigger_text)
    expect(atCollect.qualification_status).toBe(atSubmit.qualification_status)
  })

  it('carries the detectedSignal it was GIVEN, not one it recomputes', () => {
    // The snapshot exists because detectRecencySignal takes the clock. If this function
    // ever recomputed it, the snapshot would be decorative and a post near the recency
    // threshold would flip between the two phases.
    const withSignal = synthesisFromMessage(message(RESPONSE), prospect(), CLIENT_CTX,
      { has_dateable_signal: true,  signal_observation: 'x' })
    const without    = synthesisFromMessage(message(RESPONSE), prospect(), CLIENT_CTX,
      { has_dateable_signal: false, signal_observation: null })

    expect(withSignal.has_dateable_signal).toBe(true)
    expect(without.has_dateable_signal).toBe(false)
  })

  it('reports the usage from the Message, which is how the cache rate gets measured', () => {
    const out = synthesisFromMessage(message(RESPONSE), prospect(), CLIENT_CTX, SIGNAL)
    expect(out.usage.cache_read_input_tokens).toBe(6700)
    expect(out.usage.output_tokens).toBe(6200)
  })

  it('falls back rather than throwing when the batch returns a Message with no text block', () => {
    const out = synthesisFromMessage(
      message('', { content: [] as never }), prospect(), CLIENT_CTX, SIGNAL,
    )
    expect(out.candidates).toEqual([])
    expect(out.relevance_reason).toContain('No text block')
    // The tokens were still spent and must still be reported.
    expect(out.usage.output_tokens).toBe(6200)
  })
})
