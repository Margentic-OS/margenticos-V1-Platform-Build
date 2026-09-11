// THE FIT JUDGE READS EACH DIMENSION, AND CODE GIVES THE GRADE.
//
// Given identical input at temperature 0 the judge disagreed with itself on 8 of 20 prospects,
// and in 3 of those every check it recorded was the same both times: its final word was the
// unstable part. For a client whose approved profile carries a dimension list, that final word
// is now computed from the judge's readings (fit-dimensions.ts). These tests hold the seam: what
// the judge is asked, what is ignored, what a quotation is checked against, and where the list
// is read from.
//
// RULE ZERO: placeholders only. No market, buyer type, figure or company appears below.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Message } from '@anthropic-ai/sdk/resources/messages'

const db = vi.hoisted(() => ({ tables: {} as Record<string, Array<Record<string, unknown>>> }))

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

// Honours every filter loadClientContext applies, so a lost organisation or type filter shows.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      const eqs: Array<[string, unknown]> = []
      let within: [string, unknown[]] | null = null
      const rows = () => (db.tables[table] ?? [])
        .filter(r => eqs.every(([c, v]) => r[c] === v))
        .filter(r => !within || within[1].includes(r[within[0]]))
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (c: string, v: unknown) => { eqs.push([c, v]); return chain },
        in: (c: string, v: unknown[]) => { within = [c, v]; return chain },
        order: () => chain,
        single: async () => {
          const r = rows()
          return r.length === 1 ? { data: r[0], error: null } : { data: null, error: { message: 'not one row' } }
        },
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(resolve),
      }
      return chain
    },
  }),
}))

import { logger } from '@/lib/logger'
import {
  synthesisFromMessage, synthesisFallback, buildSynthesisParams, buildSynthesisUserMessage, loadClientContext,
  type ClientDocContext, type DetectedSignal,
} from '../synthesize'
import { buildSynthesisPrompt } from '../prompts/synthesis-prompt'
import type { FitDimension } from '../fit-dimensions'
import type { ProspectContext, RawSourceData } from '../types'
import { findBannedContent } from '@/agents/buyer-criterion-agent'

const DIMS: FitDimension[] = [
  { key: 'runs_own_delivery', statement: 'The company runs its own delivery.', source: 'placeholder source one', role: 'required', establishable: true },
  { key: 'placeholder_stage', statement: 'The company is at the placeholder stage.', source: 'placeholder source two', role: 'supporting', establishable: true },
  { key: 'private_terms', statement: 'The company meets the placeholder private terms.', source: 'placeholder source three', role: 'required', establishable: false },
]

const BASE_CTX: ClientDocContext = {
  clientName: 'Placeholder Client', buyerTitle: null, icpSummary: 'Placeholder summary\n  - one',
  positioningSummary: 'Placeholder positioning', valuePropContext: 'Placeholder value', tovRules: 'Placeholder rules',
}
const WITH_DIMS: ClientDocContext = { ...BASE_CTX, fitDimensions: DIMS }
const SIGNAL: DetectedSignal = { has_dateable_signal: false, signal_observation: null }

const PROSPECT = {
  id: 'p-1', organisation_id: 'org-1', segment_id: null, first_name: 'Placeholder', last_name: 'Person',
  company_name: 'Placeholder Company', role: null, job_title: 'Placeholder Title', email: null,
  linkedin_url: null, website_url: null, company: null,
} as ProspectContext

const SOURCES = {
  linkedin: { available: false, profile_data: null, recent_posts: null, formatted: null },
  apollo: { available: false, formatted: null, raw: null },
  website: { available: true, url: 'https://placeholder.example', content: 'The placeholder firm has run its own delivery since the placeholder year, from one office.', fetch_method: 'direct' },
  web_search: { available: false, person_search: null, company_search: null, combined: null },
} as unknown as RawSourceData

function message(text: string, overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg', type: 'message', role: 'assistant', model: 'placeholder-model',
    content: [{ type: 'text', text, citations: null }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ...overrides,
  } as unknown as Message
}

const answer = (fields: Record<string, unknown>) => `<reasoning>placeholder</reasoning>\n${JSON.stringify({ candidates: [], ...fields })}`
const judge = (fields: Record<string, unknown>, ctx = WITH_DIMS) =>
  synthesisFromMessage(message(answer(fields)), PROSPECT, ctx, SIGNAL, SOURCES)

const QUOTE = 'has run its own delivery since the placeholder year'

beforeEach(() => {
  vi.clearAllMocks()
  db.tables = {}
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://placeholder.invalid')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'placeholder')
})

describe('what the judge is asked, with and without a dimension list', () => {
  const withDims = buildSynthesisPrompt(WITH_DIMS)
  const without = buildSynthesisPrompt(BASE_CTX)

  it('with a list: every dimension is shown, and the judge is told the grade is not its to give', () => {
    for (const d of DIMS) expect(withDims).toContain(`${d.key}: ${d.statement}`)
    expect(withDims).toContain('THE GRADE IS NOT YOURS TO GIVE')
    expect(withDims).toContain('"fit_dimensions": {')
  })

  it('with a list: no grade is asked for anywhere', () => {
    expect(withDims).not.toContain('"icp_fit":')
    expect(withDims).not.toContain('STRONG —')
    expect(withDims).not.toContain('CANNOT_TELL —')
  })

  it('without a list: the prompt every client had before, asking for the grade', () => {
    expect(without).toContain('"icp_fit": "strong" or "moderate" or "weak" or "cannot_tell"')
    expect(without).toContain('STRONG —')
    expect(without).not.toContain('fit_dimensions')
  })

  it('the new section names no market, buyer type or company, and the scan can see a planted one', () => {
    const start = withDims.indexOf('ICP FIT: READ EACH DIMENSION')
    const end = withDims.indexOf('SIGNAL DIMENSION')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    // The dimension list itself comes from the client at run time; the placeholders here carry none.
    const section = withDims.slice(start, end)
    expect(findBannedContent(section)).toEqual([])
    expect(findBannedContent(`${section} consulting`)).toEqual(['consulting'])
  })
})

describe('the grade comes from the readings, and the judge\'s own grade is ignored', () => {
  it('a quoted miss on a required dimension is weak, whatever grade the judge volunteers', () => {
    const out = judge({ icp_fit: 'strong', fit_dimensions: { runs_own_delivery: { result: 'miss', evidence: QUOTE } } })
    expect(out.icp_fit).toBe('weak')
    expect(out.fit_dimensions?.runs_own_delivery.quote_found).toBe(true)
  })

  it('every dimension research can establish, matched with real quotations, is strong', () => {
    const out = judge({
      icp_fit: 'weak',
      fit_dimensions: {
        runs_own_delivery: { result: 'match', evidence: QUOTE },
        placeholder_stage: { result: 'match', evidence: 'from one office' },
        private_terms: { result: 'unknown', evidence: null },
      },
    })
    expect(out.icp_fit).toBe('strong')
    expect(out.icp_fit_unestablished).toEqual(['The company meets the placeholder private terms.'])
  })

  it('a match resting on a quotation that is not in the material counts as unknown', () => {
    const out = judge({ fit_dimensions: { runs_own_delivery: { result: 'match', evidence: 'words that appear nowhere in the research' } } })
    expect(out.fit_dimensions?.runs_own_delivery.counted).toBe('unknown')
    expect(out.icp_fit).toBe('cannot_tell')
    expect(out.icp_fit_missing).toContain('The company runs its own delivery.')
  })

  it('a quotation of the client context is not evidence about the prospect', () => {
    const out = judge({ fit_dimensions: { runs_own_delivery: { result: 'match', evidence: 'Placeholder positioning' } } })
    expect(out.fit_dimensions?.runs_own_delivery.quote_found).toBe(false)
  })

  it('a quotation is checked against exactly the user message the judge was sent', () => {
    const params = buildSynthesisParams(PROSPECT, SOURCES, WITH_DIMS, SIGNAL)
    expect(params.messages[0].content).toBe(buildSynthesisUserMessage(PROSPECT, SOURCES, SIGNAL))
  })

  it('without a list the judge\'s own grade stands and no readings are recorded', () => {
    const out = judge({ icp_fit: 'moderate', fit_dimensions: { runs_own_delivery: { result: 'miss', evidence: QUOTE } } }, BASE_CTX)
    expect(out.icp_fit).toBe('moderate')
    expect(out.fit_dimensions).toBeNull()
  })

  it('a call that produced no answer reaches no grade and no readings', () => {
    expect(synthesisFallback(PROSPECT, WITH_DIMS, SIGNAL, 'placeholder failure').fit_dimensions).toBeNull()
    const empty = synthesisFromMessage(message('', { content: [] as never }), PROSPECT, WITH_DIMS, SIGNAL, SOURCES)
    expect(empty.icp_fit).toBe('cannot_tell')
    expect(empty.fit_dimensions).toBeNull()
  })
})

describe('the list is read from the approved profile\'s own spec', () => {
  const ORG = 'org-1'
  const SET = { dimensions: DIMS, derived_at: new Date(0).toISOString(), model: 'test' }
  const icp = (organisation_id: string, spec: unknown) => ({
    organisation_id, status: 'active', document_type: 'icp', segment_id: 'seg-1',
    content: { tier_1: { buyer_profile: { title: 'Placeholder buyer title' } } }, icp_filter_spec: spec,
  })

  const tables = (docs: Array<Record<string, unknown>>) => ({
    organisations: [{ id: ORG, name: 'Placeholder Client' }, { id: 'org-2', name: 'Other Placeholder' }],
    strategy_documents: docs,
  })

  it('carries the stored list into the judge\'s context', async () => {
    db.tables = tables([icp(ORG, { fit_dimensions: SET })])
    expect((await loadClientContext(ORG, 'seg-1')).fitDimensions).toEqual(DIMS)
  })

  it('carries none when the spec has none, and never another organisation\'s', async () => {
    db.tables = tables([icp(ORG, { notes: 'no list' }), icp('org-2', { fit_dimensions: SET })])
    expect((await loadClientContext(ORG, 'seg-1')).fitDimensions).toBeNull()
  })

  it('a stored list that does not read carries none, and says so', async () => {
    db.tables = tables([icp(ORG, { fit_dimensions: { dimensions: [{ key: 'Not Snake' }] } })])
    expect((await loadClientContext(ORG, 'seg-1')).fitDimensions).toBeNull()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/stored fit dimensions do not read/),
      expect.objectContaining({ organisation_id: ORG }),
    )
  })
})
