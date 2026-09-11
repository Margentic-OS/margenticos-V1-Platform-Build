// The fit dimensions agent: what it reads from a profile, what it sends, and what it refuses.
//
// It runs once per ICP approval and its answer then fixes how every prospect for that client is
// graded, so an answer it cannot fully check is refused rather than stored in part.
//
// RULE ZERO: placeholders only. No market, buyer type, figure or company appears below, and the
// prompt itself is scanned for all four.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const sdk = vi.hoisted(() => ({
  created: [] as Array<Record<string, unknown>>,
  constructed: [] as Array<Record<string, unknown>>,
  reply: { text: '', stop: 'end_turn' },
}))

vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    messages = {
      create: async (params: Record<string, unknown>) => {
        sdk.created.push(params)
        return { content: [{ type: 'text', text: sdk.reply.text }], stop_reason: sdk.reply.stop }
      },
    }
    constructor(opts: Record<string, unknown>) { sdk.constructed.push(opts) }
  }
  return { default: Anthropic }
})
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import {
  deriveFitDimensions, collectFitStatements, parseFitDimensionsResponse, FIT_DIMENSIONS_PROMPT,
} from '../fit-dimensions-agent'
import { findBannedContent } from '../buyer-criterion-agent'

const DOC = {
  jtbd_statement: 'Placeholder outcome the buyer wants.',
  summary: 'Placeholder summary of who is served.',
  tier_1: {
    company_profile: {
      headcount: 'Placeholder band of staff',
      stage: 'Placeholder stage statement',
      industries: ['Placeholder Industry A', 'Placeholder Industry B'],
      unmatched_industries: ['Placeholder unmatched label'],
    },
    buyer_profile: { title: 'Placeholder buyer title', seniority: 'Placeholder seniority statement' },
    disqualifiers: ['Placeholder rule-out one.', 'Placeholder rule-out two.'],
    triggers: [{ trigger: 'Placeholder timing statement' }],
  },
  tier_2: {
    company_profile: { headcount: 'Placeholder band of staff', stage: 'Placeholder second stage statement' },
    buyer_profile: { title: 'Placeholder buyer title', seniority: 'Placeholder seniority statement' },
    disqualifiers: ['Placeholder rule-out one.'],
  },
  tier_3: {
    company_profile: { headcount: 'Placeholder band that is not targeted' },
    disqualifiers: ['Placeholder tier three rule-out.'],
  },
} as never

const ANSWER = {
  dimensions: [
    { key: 'staff_band', statement: 'The company sits in the placeholder band of staff.', source: 'Placeholder band of staff', role: 'required', establishable: true },
    { key: 'clear_of_rule_one', statement: 'The prospect is clear of placeholder rule-out one.', source: 'Placeholder rule-out one', role: 'required', establishable: false },
    { key: 'stage', statement: 'The company is at the placeholder stage.', source: 'Placeholder stage statement', role: 'supporting', establishable: true },
  ],
}

beforeEach(() => {
  sdk.created.length = 0
  sdk.constructed.length = 0
  sdk.reply.text = JSON.stringify(ANSWER)
  sdk.reply.stop = 'end_turn'
})

describe('collectFitStatements: the targeting tiers, each statement once', () => {
  const texts = collectFitStatements(DOC).map(s => s.text)

  it('reads the summary, every company field, the buyer title and seniority, and the disqualifiers', () => {
    for (const t of [
      'Placeholder summary of who is served.', 'Placeholder band of staff', 'Placeholder stage statement',
      'Placeholder Industry A, Placeholder Industry B', 'Placeholder buyer title', 'Placeholder seniority statement',
      'Placeholder rule-out one.', 'Placeholder rule-out two.', 'Placeholder second stage statement',
    ]) expect(texts).toContain(t)
  })

  it('leaves out the tier that is not targeted, timing, and unmatched labels', () => {
    for (const t of ['Placeholder band that is not targeted', 'Placeholder tier three rule-out.', 'Placeholder timing statement', 'Placeholder unmatched label']) {
      expect(texts.join('\n')).not.toContain(t)
    }
  })

  it('reads a statement the second tier repeats word for word only once', () => {
    expect(texts.filter(t => t === 'Placeholder band of staff')).toHaveLength(1)
    expect(texts.filter(t => t === 'Placeholder rule-out one.')).toHaveLength(1)
  })
})

describe('parseFitDimensionsResponse: an answer it cannot fully check is refused', () => {
  const statements = collectFitStatements(DOC)

  it('returns the list when every source is found in the profile', () => {
    expect(parseFitDimensionsResponse(JSON.stringify(ANSWER), statements).map(d => d.key))
      .toEqual(['staff_band', 'clear_of_rule_one', 'stage'])
  })

  it('refuses a dimension whose source is not in the profile, naming it', () => {
    const invented = { dimensions: [...ANSWER.dimensions, { ...ANSWER.dimensions[0], key: 'invented', source: 'words the profile never used' }] }
    expect(() => parseFitDimensionsResponse(JSON.stringify(invented), statements)).toThrow(/invented/)
  })

  it('refuses a malformed list and an answer with no JSON', () => {
    const duplicated = { dimensions: [ANSWER.dimensions[0], ANSWER.dimensions[0]] }
    expect(() => parseFitDimensionsResponse(JSON.stringify(duplicated), statements)).toThrow(/appears twice/)
    expect(() => parseFitDimensionsResponse('no object here', statements)).toThrow(/no JSON/)
  })
})

describe('deriveFitDimensions: what it sends and what it returns', () => {
  it('sends the profile to the named model at temperature 0, bounded, with this prompt', async () => {
    const set = await deriveFitDimensions({ doc: DOC, apiKey: 'placeholder-key' })
    expect(sdk.created).toHaveLength(1)
    const params = sdk.created[0]
    expect(params.model).toBe('claude-opus-4-6')
    expect(params.temperature).toBe(0)
    expect(params.system).toBe(FIT_DIMENSIONS_PROMPT)
    expect(JSON.stringify(params.messages)).toContain('Placeholder rule-out two.')
    expect(sdk.constructed[0]).toMatchObject({ timeout: 60_000, maxRetries: 2 })
    expect(set.model).toBe('claude-opus-4-6')
    expect(set.dimensions).toHaveLength(3)
  })

  it('refuses an answer cut off at the token limit', async () => {
    sdk.reply.stop = 'max_tokens'
    await expect(deriveFitDimensions({ doc: DOC, apiKey: 'placeholder-key' })).rejects.toThrow(/cut off/)
  })

  it('makes no call for a profile with nothing on its targeting tiers', async () => {
    await expect(deriveFitDimensions({ doc: { tier_1: {}, tier_2: {}, tier_3: {} } as never, apiKey: 'k' })).rejects.toThrow(/states nothing/)
    expect(sdk.created).toHaveLength(0)
  })
})

describe('Rule Zero: the prompt names no market, buyer type, figure or company', () => {
  it('carries no job title or industry vocabulary, and no canonical industry name', () => {
    expect(findBannedContent(FIT_DIMENSIONS_PROMPT)).toEqual([])
  })

  it('carries no money figure or currency', () => {
    expect(FIT_DIMENSIONS_PROMPT).not.toMatch(/[$£€¥]|\b\d+(?:[.,]\d+)?\s*(?:k|m|bn|million|thousand|billion)\b/i)
  })

  it('the scan finds a planted term, so an empty result means clean rather than blind', () => {
    expect(findBannedContent(`${FIT_DIMENSIONS_PROMPT}\nconsulting`)).toEqual(['consulting'])
  })
})
