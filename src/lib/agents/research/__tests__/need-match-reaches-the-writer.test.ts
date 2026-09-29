// THE SEAM. A check that decides correctly is worth nothing if it is never called, or is
// called without the document it judges against.
//
// This project has paid for that twice: three fields declared on WriteAndJudgeParams and
// never passed, undefined in production for their whole life with green tests on both ends;
// and a findingsEvidence corpus a gate's doc comment claimed to read, which appeared once in
// the file as an interface declaration and was never destructured. Both ends green, the join
// missing. So the join is asserted here rather than assumed.
//
// FOUR THINGS, and each one is a different way the wiring can be wrong:
//   loadClientContext really builds the document from the positioning row
//   produceOpening really calls the check, with THAT document in the prompt
//   it does NOT call it when the fact-check already rejected the attempt (the cost rule)
//   it does NOT call it when there is no document (the off switch)
//
// RULE ZERO. Every fixture is invented and industry-neutral.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const db = vi.hoisted(() => ({ tables: {} as Record<string, Array<Record<string, unknown>>> }))
const createMock = vi.hoisted(() => vi.fn())
const { writeAndJudgeOpening } = vi.hoisted(() => ({ writeAndJudgeOpening: vi.fn() }))

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

vi.mock('@anthropic-ai/sdk', () => ({
  default: class { messages = { create: createMock } },
}))

// Honours every filter loadClientContext applies, so a lost organisation or type filter shows.
// Lifted from judge-dimensions.test.ts, which holds the same seam for fit dimensions.
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

// importOriginal, so buildFindingsBlock and buildFindingsEvidence stay REAL. A whole-module
// factory would replace them with undefined and produceOpening would fail for a reason that
// has nothing to do with what is being tested.
vi.mock('../write-opening', async importOriginal => ({
  ...(await importOriginal<typeof import('../write-opening')>()),
  writeAndJudgeOpening,
}))

vi.mock('@/lib/composition/compose-sequence', () => ({
  getVariantEmail1Frame: () => ({ p3: 'The offer line.', cta: 'Is that useful?', authoredOpening: 'The approved opening.' }),
  composeEmail1WithOpening: vi.fn(),
}))

import { produceOpening } from '../produce-opening'
import { loadClientContext } from '../synthesize'
import { flattenPositioningText } from '../positioning-text'
import type { ObservationCandidate, ProspectContext } from '../types'

const POSITIONING = {
  positioning_summary: 'We find and contact people who have never dealt with the client before.',
  value_themes: [{ theme: 'A steady flow of first conversations with people outside the existing network.' }],
}
const TEXT = flattenPositioningText(POSITIONING)

const ctx: ProspectContext = {
  id: 'p1', organisation_id: 'org1', segment_id: null, first_name: 'Sam', last_name: null,
  company_name: 'Example Co', country: null, role: null, job_title: 'Founder', email: null,
  linkedin_url: null, website_url: null, company: null,
}

const CANDIDATE = {
  id: 'c1', observation: 'You added a second press in March.', source: 'website', provenance: 'example.com',
  date: null, is_composite: false,
  scores: { specific: true, verifiable: true, inferential: true, relevant: true, useful: true, non_judgemental: true },
  passes_all: true, score_total: 6, model_readable_claim: true,
  opposite_reading: 'It may replace an old press.', inference_direction: 'compatible_with_both',
  readability: { hard_fail: false, penalty: 0, max_sentence_words: 7, hedges: [], nominalisation_density: 0, nominalisation_over_threshold: false, reasons: [] },
  demoted: false, rejection_reason: null,
} as unknown as ObservationCandidate

// Deliberately NOT a sentence the Email 1 fact-check's own shape rules would flag: it names
// no company, does not begin with you or your, and asserts no arrangement. Anything it
// rejected on its own would mask whether the need-match check ran at all.
const BRIDGE = 'Work like that tends to land before the next set of buyers does.'
const QUESTION = 'Worth a short call?'

const say = (text: string) => ({ content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } })

const FACT_CHECK_CLEAN = say('{"claims":[]}')
const FACT_CHECK_FAILS = say('{"claims":[{"email":1,"claim":"the next set of buyers","finding":null,"supported":false,"why":"no finding names their buyers"}]}')
const NEED_UNSUPPORTED = say('{"needs":[{"email":1,"need":"putting their own article in front of more people","line":null,"quote":"","supported":false,"why":"the document describes contacting new people, not distributing their content"}]}')
const NEED_SUPPORTED = say('{"needs":[{"email":1,"need":"first conversations outside the network","line":2,"quote":"A steady flow of first conversations","supported":true,"why":"same work"}]}')

/** The need-match call is the one whose system block carries this sentence. */
const isNeedMatch = (args: { system: unknown }) =>
  Array.isArray(args.system) && String((args.system[0] as { text: string }).text).includes('You check whether the NEEDS')

const needMatchCalls = () => createMock.mock.calls.filter(([a]) => isNeedMatch(a))

/** Drive produceOpening, then return the factCheck closure it handed the writer. */
async function closureFor(positioningText?: string) {
  await produceOpening({
    apiKey: 'k', clientName: 'Client', ctx, candidates: [CANDIDATE],
    selectedCandidateId: 'c1', relevanceReason: 'R',
    messagingContent: {} as never, variantId: 'A', positioningText,
  })
  const params = writeAndJudgeOpening.mock.calls[0][0] as {
    factCheck?: (c: { bridge: string; question: string }) => Promise<string[]>
  }
  // A closure that was never passed would make every assertion below vacuous.
  expect(params.factCheck).toBeTypeOf('function')
  return params.factCheck!
}

beforeEach(() => {
  createMock.mockReset()
  writeAndJudgeOpening.mockReset()
  writeAndJudgeOpening.mockResolvedValue({ written_won: false, judge_reasoning: 'r', usage: {} })
  db.tables = {
    organisations: [{ id: 'org1', name: 'Client' }],
    segments: [{ id: 'seg1', organisation_id: 'org1', is_default: true }],
    strategy_documents: [
      { organisation_id: 'org1', document_type: 'positioning', status: 'active', segment_id: null, content: POSITIONING, icp_filter_spec: null },
    ],
  }
})

describe('loadClientContext builds the whole positioning document, not a summary of it', () => {
  it('carries every string leaf, labelled, from the active positioning row', async () => {
    const clientCtx = await loadClientContext('org1', 'seg1')
    expect(clientCtx.positioningText).toBe(TEXT)
    expect(clientCtx.positioningText).toContain('value_themes[0].theme: A steady flow')
    // AND IT IS NOT THE SUMMARY. The two existing positioning strings are built from three
    // fields; this is the corpus. If they were ever the same value the check would be
    // judging needs against 7% of the document and nothing would say so.
    expect(clientCtx.positioningText).not.toBe(clientCtx.positioningSummary)
    expect(clientCtx.positioningText).not.toBe(clientCtx.valuePropContext)
  })

  it('is null when the client has no positioning document, which turns the check off', async () => {
    db.tables.strategy_documents = []
    const clientCtx = await loadClientContext('org1', 'seg1')
    expect(clientCtx.positioningText).toBeNull()
    // Positive control: the read happened and returned a context, so the null above is the
    // absent document rather than a throw swallowed somewhere.
    expect(clientCtx.clientName).toBe('Client')
  })
})

describe('produceOpening calls the check, with the document, at the right moment', () => {
  it('runs it after a clean fact-check and returns its failure to the writer', async () => {
    createMock.mockImplementation(async (a: { system: unknown }) => isNeedMatch(a) ? NEED_UNSUPPORTED : FACT_CHECK_CLEAN)

    const failures = await (await closureFor(TEXT))({ bridge: BRIDGE, question: QUESTION })

    expect(needMatchCalls()).toHaveLength(1)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('putting their own article in front of more people')
    expect(failures[0]).toContain('Name a need this service does meet, or drop it.')
  })

  it('sends THAT client\'s document, numbered, and both the bridge and the question', async () => {
    createMock.mockImplementation(async (a: { system: unknown }) => isNeedMatch(a) ? NEED_SUPPORTED : FACT_CHECK_CLEAN)
    await (await closureFor(TEXT))({ bridge: BRIDGE, question: QUESTION })

    const [args] = needMatchCalls()[0] as [{ system: Array<{ text: string }>; messages: Array<{ content: string }> }]
    const system = args.system[0].text
    expect(system).toContain('1. [positioning_summary] We find and contact people')
    expect(system).toContain('2. [value_themes[0].theme] A steady flow')
    // THE QUESTION, NOT ONLY THE BRIDGE. The operator's failing example was a CTA, so a
    // version reading the bridge alone would have passed the thing this was built for.
    const user = args.messages[0].content
    expect(user).toContain(BRIDGE)
    expect(user).toContain(QUESTION)
  })

  it('passes copy whose need the document does support', async () => {
    createMock.mockImplementation(async (a: { system: unknown }) => isNeedMatch(a) ? NEED_SUPPORTED : FACT_CHECK_CLEAN)
    const failures = await (await closureFor(TEXT))({ bridge: BRIDGE, question: QUESTION })
    // Positive control alongside it: the check really ran, so the empty result is a verdict
    // rather than a check that was skipped.
    expect(needMatchCalls()).toHaveLength(1)
    expect(failures).toEqual([])
  })

  it('does NOT run it when the fact-check already rejected the attempt', async () => {
    createMock.mockImplementation(async (a: { system: unknown }) => isNeedMatch(a) ? NEED_UNSUPPORTED : FACT_CHECK_FAILS)

    const failures = await (await closureFor(TEXT))({ bridge: BRIDGE, question: QUESTION })

    // The cost rule. An attempt already being rewritten is not worth a second Sonnet call.
    expect(needMatchCalls()).toHaveLength(0)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('which the findings do not support')
  })

  it('does NOT run it when the client has no positioning document', async () => {
    createMock.mockImplementation(async () => FACT_CHECK_CLEAN)
    const failures = await (await closureFor(undefined))({ bridge: BRIDGE, question: QUESTION })
    expect(needMatchCalls()).toHaveLength(0)
    expect(failures).toEqual([])
    // Positive control: the fact-check DID run, so the absent need-match call above is the
    // off switch rather than a closure that returned early on the empty-copy guard.
    expect(createMock.mock.calls).toHaveLength(1)
  })

  it('does not call any model when both the bridge and the question are empty', async () => {
    createMock.mockImplementation(async () => FACT_CHECK_CLEAN)
    const failures = await (await closureFor(TEXT))({ bridge: '  ', question: '' })
    expect(createMock.mock.calls).toHaveLength(0)
    expect(failures).toEqual([])
  })
})
