// The short_reasoning arm changes ONE thing: a single instruction appended to the user message.
//
// The claim these pin, and why each one matters:
//   1. The standard arm builds byte-for-byte what it built before the arm existed. Every caller that
//      does not name an arm, and every stored request, is unchanged.
//   2. The short arm's system block is identical to the standard arm's. The cached prefix is shared,
//      so the arm never costs a cache miss. A change here would be a silent cost rise.
//   3. The short arm differs from standard only by appending SHORT_REASONING_INSTRUCTION, so the
//      experiment that was measured (2026-10-01) is the one that runs.
//   4. A truncated short-arm answer retried under the constrained instruction keeps both, and the
//      constrained one comes last, because it is the stronger instruction.
//   5. Model, temperature and output ceiling do not depend on the arm.

import { describe, it, expect } from 'vitest'
import {
  buildSynthesisParams,
  CONSTRAINED_REASONING_INSTRUCTION,
  SHORT_REASONING_INSTRUCTION,
  type ClientDocContext,
  type DetectedSignal,
} from '../synthesize'
import type { ProspectContext, RawSourceData } from '../types'

const CLIENT_CTX: ClientDocContext = {
  clientName:         'Northwind Advisory',
  buyerTitle:         'Operations Lead',
  triggers: [],
  icpSummary:         'Their ideal client: operations lead at growth stage.',
  positioningSummary: 'They shorten the gap between a signed contract and a working system.',
  valuePropContext:   'Core pain solved: "projects stall between sale and delivery"',
  tovRules:           'Plain, specific, no hype.',
}

const SIGNAL: DetectedSignal = {
  has_dateable_signal: true,
  signal_observation:  'LinkedIn post 2026-08-20: opened a second delivery pod',
}

function prospect(): ProspectContext {
  return {
    id: 'p-1', organisation_id: 'org-1', segment_id: 'seg-1',
    first_name: 'Ada', last_name: 'Okoro', company_name: 'Meridian Systems', country: null,
    role: 'Head of Delivery', job_title: 'Head of Delivery', email: 'ada@example.com',
    linkedin_url: 'https://www.linkedin.com/in/example', website_url: 'https://example.com', company: null,
  }
}

function sources(): RawSourceData {
  return {
    linkedin:   { available: true, profile_data: null, recent_posts: [], formatted: 'Posted about a second delivery pod.', error: undefined },
    apollo:     { available: true, formatted: 'Head of Delivery since 2024.', raw: null, error: undefined },
    website:    { available: true, url: 'https://example.com', content: 'We build delivery systems.', fetch_method: 'fetch', error: undefined },
    web_search: {
      available: true, person_search: null, company_search: null,
      combined: 'Meridian Systems opened a second pod in August.',
      error: undefined, providers: [], search_count: 1, result_count: 1, input_tokens: 0, output_tokens: 0, model: null,
    },
  } as unknown as RawSourceData
}

function userText(params: ReturnType<typeof buildSynthesisParams>): string {
  return String((params.messages[0] as { content: unknown }).content)
}

describe('research arm: the request each arm sends', () => {
  it('the standard arm is the request as it was built before arms existed, byte for byte', () => {
    const omitted = buildSynthesisParams(prospect(), sources(), CLIENT_CTX, SIGNAL, '5m')
    const standard = buildSynthesisParams(prospect(), sources(), CLIENT_CTX, SIGNAL, '5m', false, 'standard')
    expect(JSON.stringify(standard)).toBe(JSON.stringify(omitted))
    expect(userText(standard)).not.toContain(SHORT_REASONING_INSTRUCTION)
  })

  it('the short arm differs from standard only by appending the measured instruction to the user message', () => {
    const standard = buildSynthesisParams(prospect(), sources(), CLIENT_CTX, SIGNAL, '5m', false, 'standard')
    const short = buildSynthesisParams(prospect(), sources(), CLIENT_CTX, SIGNAL, '5m', false, 'short_reasoning')
    expect(userText(short)).toBe(userText(standard) + SHORT_REASONING_INSTRUCTION)
  })

  it('the cached system block is identical across arms, so the short arm never costs a cache miss', () => {
    const standard = buildSynthesisParams(prospect(), sources(), CLIENT_CTX, SIGNAL, '5m', false, 'standard')
    const short = buildSynthesisParams(prospect(), sources(), CLIENT_CTX, SIGNAL, '5m', false, 'short_reasoning')
    expect(JSON.stringify(short.system)).toBe(JSON.stringify(standard.system))
  })

  it('model, temperature and output ceiling do not depend on the arm', () => {
    const standard = buildSynthesisParams(prospect(), sources(), CLIENT_CTX, SIGNAL, '5m', false, 'standard')
    const short = buildSynthesisParams(prospect(), sources(), CLIENT_CTX, SIGNAL, '5m', false, 'short_reasoning')
    expect(short.model).toBe(standard.model)
    expect(short.temperature).toBe(standard.temperature)
    expect(short.max_tokens).toBe(standard.max_tokens)
  })

  it('a truncated short-arm answer retried constrained keeps both instructions, the constrained one last', () => {
    const retry = buildSynthesisParams(prospect(), sources(), CLIENT_CTX, SIGNAL, '5m', true, 'short_reasoning')
    const text = userText(retry)
    expect(text).toContain(SHORT_REASONING_INSTRUCTION)
    expect(text).toContain(CONSTRAINED_REASONING_INSTRUCTION)
    expect(text.indexOf(CONSTRAINED_REASONING_INSTRUCTION)).toBeGreaterThan(text.indexOf(SHORT_REASONING_INSTRUCTION))
  })

  it('the arm is pure: the same inputs give the same bytes on every call', () => {
    const a = buildSynthesisParams(prospect(), sources(), CLIENT_CTX, SIGNAL, '5m', false, 'short_reasoning')
    const b = buildSynthesisParams(prospect(), sources(), CLIENT_CTX, SIGNAL, '5m', false, 'short_reasoning')
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})
