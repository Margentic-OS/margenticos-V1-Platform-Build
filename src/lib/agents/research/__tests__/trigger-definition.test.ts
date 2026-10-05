// A personalised opening rests on a fact that is what its trigger says it is (2026-10-03).
//
// Each of the client's triggers may carry a written DEFINITION: what counts as that event
// and what does not. When the trigger the selected fact matched has one, one small model
// call reads the fact against it before the writer runs, and a fact outside it is held
// exactly as a fact that matched no trigger is held.
//
// What is held here, each a different way the rule could exist and not apply:
//   1. A fact OUTSIDE the definition writes no opening, and the writer is never called.
//   2. A fact INSIDE it is written as before, and the check's tokens are counted.
//   3. NO DEFINITION makes no call at all: today's behaviour, at today's cost.
//   4. AN UNUSABLE ANSWER HOLDS. Unparseable, truncated and failed calls are not a pass.
//   5. The definition reaches synthesis's rendered trigger list, and a list without one
//      renders byte-identical to before.
//   6. The checked loader the upload gate uses carries the definition too.
//
// RULE ZERO. Every fixture is invented and industry-neutral.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { writeAndJudgeOpening } = vi.hoisted(() => ({ writeAndJudgeOpening: vi.fn() }))
const { writeFollowups } = vi.hoisted(() => ({ writeFollowups: vi.fn() }))
const { checkBridgeStatesReason } = vi.hoisted(() => ({ checkBridgeStatesReason: vi.fn() }))
const createMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
// The SDK's error classes are kept: the fatal-error check reads them on the failed-call path.
vi.mock('@anthropic-ai/sdk', async importOriginal => ({
  ...(await importOriginal<typeof import('@anthropic-ai/sdk')>()),
  default: class { messages = { create: createMock } },
}))
vi.mock('../write-opening', async importOriginal => ({
  ...(await importOriginal<typeof import('../write-opening')>()),
  writeAndJudgeOpening,
}))
vi.mock('../write-followups', async importOriginal => ({
  ...(await importOriginal<typeof import('../write-followups')>()),
  writeFollowups,
}))
vi.mock('../reason-match', async importOriginal => ({
  ...(await importOriginal<typeof import('../reason-match')>()),
  checkBridgeStatesReason,
}))
vi.mock('@/lib/composition/compose-sequence', () => ({
  getVariantEmail1Frame: () => ({ p3: 'The offer line.', cta: 'Is that useful?', authoredOpening: 'The approved opening.' }),
  composeEmail1WithOpening: () => ({ body: 'The composed Email 1.', subject_line: 'a subject' }),
  variantOfferAngles: () => ({}),
}))

import { HOLDING_STATES, holdsPersonalisation, resolveApprovedReason } from '../approved-reason'
import { produceOpening } from '../produce-opening'
import { checkFactWithinDefinition, readDefinitionReply, TRIGGER_DEFINITION_MODEL, TRIGGER_DEFINITION_SYSTEM_PROMPT } from '../trigger-definition'
import { buildSynthesisPrompt } from '../prompts/synthesis-prompt'
import { loadTriggersChecked } from '@/lib/composition/opening-reason'
import type { ObservationCandidate, ProspectContext } from '../types'

const DEFINITION =
  'Counts: a new person who will run the machines or serve customers directly. ' +
  'Does not count: an office, finance or marketing hire, or a post that names a person without their role.'

const TRIGGERS = [
  { trigger: 'A role is advertised for someone who runs the machines.', reason: 'More people on the machines points to more orders.', definition: DEFINITION },
  { trigger: 'A new site is opened.', reason: 'A new site means the firm is reaching a new area.' },
]

const candidate = (id: string, matched_trigger: number | null, observation: string): ObservationCandidate => ({
  id, observation, source: 'website', provenance: 'example.com/news', date: '2026-09-01', is_composite: false,
  scores: { specific: true, verifiable: true, inferential: true, relevant: true, useful: true, non_judgemental: true },
  passes_all: true, score_total: 6, model_readable_claim: true, matched_trigger,
  opposite_reading: null, inference_direction: 'compatible_with_both',
  readability: { hard_fail: false, penalty: 0, max_sentence_words: 7, hedges: [], nominalisation_density: 0, nominalisation_over_threshold: false, reasons: [] },
  demoted: false, rejection_reason: null,
} as unknown as ObservationCandidate)

const HIRE = candidate('c-hire', 1, 'Your blog welcomed a new team member in September.')
const SITE = candidate('c-site', 2, 'You opened a second site in August.')
const ALL = [HIRE, SITE]

const ctx: ProspectContext = {
  id: 'p1', organisation_id: 'org1', segment_id: null, first_name: 'Sam', last_name: null,
  company_name: 'Example Co', country: null, role: null, job_title: 'Owner', email: null,
  linkedin_url: null, website_url: null, company: null,
}

const ZERO = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, calls: 0 }
const WIN = {
  opening: 'You opened a second site in August. A new site means reaching a new area.',
  observation: 'You opened a second site in August.', bridge: 'A new site means reaching a new area.',
  question: 'Is reaching that area part of the plan?', subject: null, written_won: true, retry_used: false,
  retries_used: 0, strong_material: false, judge_reasoning: 'send', usage: ZERO, comparisons: [], gate_failures: [], attempts: [],
}

const reply = (text: string, stop_reason = 'end_turn') =>
  ({ content: [{ type: 'text', text }], stop_reason, usage: { input_tokens: 40, output_tokens: 12 } })

beforeEach(() => {
  writeAndJudgeOpening.mockReset()
  writeFollowups.mockReset()
  checkBridgeStatesReason.mockReset()
  createMock.mockReset()
  writeAndJudgeOpening.mockResolvedValue(WIN)
  writeFollowups.mockResolvedValue({ email2: { prose: null, failures: [] }, email3: { prose: null, failures: [] }, usage: null, retries_used: 0, attempts: [] })
  checkBridgeStatesReason.mockResolvedValue({ verdict: { says: 'x', same: true, adds: [] }, failures: [], usage: ZERO, raw: '' })
})

const run = (selected: string, triggers: ReadonlyArray<{ trigger: string; reason: string; definition?: string }> = TRIGGERS) => produceOpening({
  apiKey: 'k', clientName: 'Client', ctx, candidates: ALL, selectedCandidateId: selected, relevanceReason: 'R',
  prospectReason: 'A sentence synthesis wrote.', messagingContent: {} as never, variantId: 'A', triggers,
})

describe('the matched trigger\'s definition travels with the approved reason', () => {
  it('resolveApprovedReason carries the definition when the trigger has one, and no key when it does not', () => {
    expect(resolveApprovedReason(ALL, 'c-hire', TRIGGERS)).toMatchObject({ state: 'approved', triggerIndex: 1, definition: DEFINITION })
    expect(resolveApprovedReason(ALL, 'c-site', TRIGGERS)).not.toHaveProperty('definition')
    expect(resolveApprovedReason(ALL, 'c-hire', [{ ...TRIGGERS[0], definition: '   ' }, TRIGGERS[1]])).not.toHaveProperty('definition')
  })

  it('outside_definition is a holding state', () => {
    expect(HOLDING_STATES).toContain('outside_definition')
    expect(holdsPersonalisation({ state: 'outside_definition', trigger: 't', triggerIndex: 1, verdict: 'outside', why: 'w' })).toBe(true)
  })
})

describe('produceOpening holds a fact outside its trigger\'s definition', () => {
  it('PLANTED: a fact outside the definition writes no opening, the writer is never called, and the model\'s reason is recorded', async () => {
    createMock.mockResolvedValueOnce(reply('{"within": false, "reason": "The post names a person but not a role that runs the machines."}'))
    const out = await run('c-hire')
    expect(writeAndJudgeOpening).not.toHaveBeenCalled()
    expect(writeFollowups).not.toHaveBeenCalled()
    expect(out).toMatchObject({
      not_written_reason: 'no_approved_reason', written_won: false, opening: null,
      approved_reason: {
        state: 'outside_definition', triggerIndex: 1, verdict: 'outside',
        why: 'The post names a person but not a role that runs the machines.',
      },
    })
    expect(out.judge_reasoning).toContain('The post names a person but not a role that runs the machines.')
    // The check was paid for, so it is counted, on the result every cost figure reads.
    expect(out.usage).toMatchObject({ input_tokens: 40, output_tokens: 12, calls: 1 })
  })

  it('the call is one Haiku call at temperature 0, given the trigger, its definition and the fact with its source', async () => {
    createMock.mockResolvedValueOnce(reply('{"within": false, "reason": "No role is named."}'))
    await run('c-hire')
    expect(createMock).toHaveBeenCalledTimes(1)
    const body = createMock.mock.calls[0][0] as { model: string; temperature: number; max_tokens: number; system: string; messages: Array<{ content: string }> }
    expect(body.model).toBe(TRIGGER_DEFINITION_MODEL)
    expect(body.model).toBe('claude-haiku-4-5-20251001')
    expect(body.temperature).toBe(0)
    expect(body.max_tokens).toBeLessThanOrEqual(300)
    const user = body.messages[0].content
    expect(user).toContain(TRIGGERS[0].trigger)
    expect(user).toContain(DEFINITION)
    expect(user).toContain(HIRE.observation)
    expect(user).toContain('example.com/news')
  })

  it('PLANTED: a fact inside the definition is written as before, and the check\'s tokens are in the opening usage', async () => {
    createMock.mockResolvedValueOnce(reply('{"within": true, "reason": "A role running the machines is named."}'))
    const out = await run('c-hire')
    expect(writeAndJudgeOpening).toHaveBeenCalledTimes(1)
    expect(out.written_won).toBe(true)
    expect(out.approved_reason).toMatchObject({ state: 'approved', triggerIndex: 1 })
    expect(out.usage).toMatchObject({ input_tokens: 40, output_tokens: 12, calls: 1 })
  })

  it('PLANTED: a trigger with no definition makes no call, and the opening is written exactly as before', async () => {
    const out = await run('c-site')
    expect(createMock).not.toHaveBeenCalled()
    expect(writeAndJudgeOpening).toHaveBeenCalledTimes(1)
    expect(out.usage).toEqual(ZERO)
  })

  it('a client whose triggers carry no definition at all makes no call', async () => {
    await run('c-hire', TRIGGERS.map(({ trigger, reason }) => ({ trigger, reason })))
    expect(createMock).not.toHaveBeenCalled()
    expect(writeAndJudgeOpening).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['an answer that is not JSON', () => createMock.mockResolvedValueOnce(reply('It looks like it counts.'))],
    ['an answer missing its verdict', () => createMock.mockResolvedValueOnce(reply('{"reason": "maybe"}'))],
    ['an answer with no reason', () => createMock.mockResolvedValueOnce(reply('{"within": true, "reason": ""}'))],
    ['a truncated answer, even one that reads as a pass', () => createMock.mockResolvedValueOnce(reply('{"within": true, "reason": "Counts."}', 'max_tokens'))],
    ['a failed call', () => createMock.mockRejectedValueOnce(new Error('connection reset'))],
  ])('PLANTED: %s holds the opening, with its own reason', async (_name, arrange) => {
    arrange()
    const out = await run('c-hire')
    expect(writeAndJudgeOpening).not.toHaveBeenCalled()
    expect(out.opening).toBeNull()
    expect(out.approved_reason).toMatchObject({ state: 'outside_definition', verdict: 'unusable' })
    const why = (out.approved_reason as { why: string }).why
    expect(why).toMatch(/could not be checked/)
  })
})

describe('the reply reader', () => {
  it('reads a verdict and its reason, and nothing else', () => {
    expect(readDefinitionReply('{"within": true, "reason": "Counts."}')).toEqual({ within: true, reason: 'Counts.' })
    expect(readDefinitionReply('Here: {"within": false, "reason": "Does not."} done')).toEqual({ within: false, reason: 'Does not.' })
    expect(readDefinitionReply('{"within": "yes", "reason": "x"}')).toBeNull()
    expect(readDefinitionReply('')).toBeNull()
  })

  it('a stub client can stand in for the SDK, and the module returns the usage it was billed', async () => {
    const create = vi.fn().mockResolvedValue(reply('{"within": false, "reason": "No."}'))
    const result = await checkFactWithinDefinition({
      apiKey: 'k', trigger: 't', definition: 'd', fact: { observation: 'o', source: 'website', provenance: 'p', date: null },
      prospectId: 'p1', client: { messages: { create } },
    })
    expect(result).toMatchObject({ verdict: 'outside', why: 'No.', usage: { input_tokens: 40, calls: 1 } })
  })

  it('RULE ZERO: the prompt names no market, buyer or kind of work', () => {
    expect(TRIGGER_DEFINITION_SYSTEM_PROMPT).not.toMatch(/consult|coach|agenc|SaaS|outbound|marketing|sales|hire|hiring|founder/i)
  })
})

describe('the definition reaches synthesis', () => {
  const base = {
    clientName: 'Client', icpSummary: 'SUMMARY', positioningSummary: 'POSITIONING', valuePropContext: '', tovRules: 'TOV',
  } as unknown as Parameters<typeof buildSynthesisPrompt>[0]

  it('PLANTED: the rendered trigger list carries each definition under its trigger', () => {
    const prompt = buildSynthesisPrompt({ ...base, triggers: TRIGGERS })
    const at = prompt.indexOf(TRIGGERS[0].trigger)
    expect(at).toBeGreaterThan(-1)
    expect(prompt.indexOf(DEFINITION)).toBeGreaterThan(at)
    expect(prompt.indexOf(DEFINITION)).toBeLessThan(prompt.indexOf(TRIGGERS[1].trigger))
  })

  it('a list with no definition renders byte-identical to the same list without the field', () => {
    const plain = TRIGGERS.map(({ trigger, reason }) => ({ trigger, reason }))
    const blank = TRIGGERS.map(({ trigger, reason }) => ({ trigger, reason, definition: '  ' }))
    expect(buildSynthesisPrompt({ ...base, triggers: blank })).toBe(buildSynthesisPrompt({ ...base, triggers: plain }))
    expect(buildSynthesisPrompt({ ...base, triggers: plain })).not.toMatch(/WHAT COUNTS/)
  })
})

describe('the checked loader carries the definition', () => {
  const supabaseWith = (triggers: unknown) => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => Promise.resolve({ data: table === 'segments' ? { id: 'seg-1' } : null, error: null }),
        order: () => Promise.resolve({ data: [{ content: { tier_1: { triggers } }, segment_id: 'seg-1' }], error: null }),
        limit: () => { throw new Error('fake does not implement limit()') },
      }
      return chain
    },
  }) as never

  it('PLANTED: a definition on the document reaches the trigger list, and a missing one adds no key', async () => {
    const out = await loadTriggersChecked(supabaseWith(TRIGGERS), 'org1', null)
    expect(out).toEqual({ ok: true, triggers: [
      { trigger: TRIGGERS[0].trigger, reason: TRIGGERS[0].reason, definition: DEFINITION },
      { trigger: TRIGGERS[1].trigger, reason: TRIGGERS[1].reason },
    ] })
    if (out.ok) expect(out.triggers[1]).not.toHaveProperty('definition')
  })
})
