// The reason a personalised opening argues from is the one the client approved (operator
// note 5 on the second reading, 2026-10-01).
//
// Four things are held here, each a different way the rule could exist and not apply:
//   1. resolveApprovedReason decides correctly, for every state.
//   2. THE HOLD: a fact with no approved reason behind it writes no opening, and the writer
//      is not called at all.
//   3. THE JOIN: the approved sentence, verbatim, is what reaches the writer and the
//      follow-up writer, in place of the sentence synthesis wrote.
//   4. The assignment block says the reason is approved and what follows from that.
//
// The check that reads the finished line back against the reason is in reason-match.test.ts.
//
// RULE ZERO. Every fixture is invented and industry-neutral.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const { writeAndJudgeOpening } = vi.hoisted(() => ({ writeAndJudgeOpening: vi.fn() }))
const { writeFollowups } = vi.hoisted(() => ({ writeFollowups: vi.fn() }))
const { checkBridgeStatesReason } = vi.hoisted(() => ({ checkBridgeStatesReason: vi.fn() }))
const createMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: createMock } } }))
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

import { HOLDING_STATES, holdsPersonalisation, reasonTheWritersArgueFrom, resolveApprovedReason } from '../approved-reason'
import { evidenceWithApprovedReason, produceOpening, NO_APPROVED_REASON_REASON } from '../produce-opening'
import { APPROVED_REASON_HEADING, buildWriterAssignment } from '../write-opening'
import type { ObservationCandidate, ProspectContext } from '../types'

const TRIGGERS = [
  { trigger: 'A second machine is installed.', reason: 'A second machine points to growth, and growth needs more orders.' },
  { trigger: 'A new site is opened.', reason: 'A new site means the firm is reaching a new area.' },
  { trigger: 'An award is won.', reason: '' },
]

const candidate = (id: string, matched_trigger: number | null | undefined, observation = `Observation ${id}.`): ObservationCandidate => ({
  id, observation, source: 'website', provenance: 'example.com', date: null, is_composite: false,
  scores: { specific: true, verifiable: true, inferential: true, relevant: true, useful: true, non_judgemental: true },
  passes_all: true, score_total: 6, model_readable_claim: true, matched_trigger,
  opposite_reading: null, inference_direction: 'compatible_with_both',
  readability: { hard_fail: false, penalty: 0, max_sentence_words: 7, hedges: [], nominalisation_density: 0, nominalisation_over_threshold: false, reasons: [] },
  demoted: false, rejection_reason: null,
} as unknown as ObservationCandidate)

const MACHINE = candidate('c-machine', 1, 'You installed a second machine in March.')
const SITE = candidate('c-site', 2)
const AWARD = candidate('c-award', 3)
const UNMATCHED = candidate('c-unmatched', null)
const ALL = [MACHINE, SITE, AWARD, UNMATCHED]

describe('resolveApprovedReason', () => {
  it('returns the approved sentence of the trigger the selected fact matched, verbatim', () => {
    expect(resolveApprovedReason(ALL, 'c-machine', TRIGGERS)).toEqual({
      state: 'approved', reason: 'A second machine points to growth, and growth needs more orders.',
      trigger: 'A second machine is installed.', triggerIndex: 1,
    })
    expect(resolveApprovedReason(ALL, 'c-site', TRIGGERS)).toMatchObject({ state: 'approved', triggerIndex: 2 })
  })

  it('PLANTED: a fact that matched no trigger has no approved reason', () => {
    expect(resolveApprovedReason(ALL, 'c-unmatched', TRIGGERS)).toEqual({ state: 'no_trigger_matched' })
    expect(resolveApprovedReason([candidate('c', undefined)], 'c', TRIGGERS)).toEqual({ state: 'no_trigger_matched' })
  })

  it('PLANTED: a position outside the list is not a match, in either direction', () => {
    for (const position of [0, -1, 4, 1.5, Number.NaN]) {
      expect(resolveApprovedReason([candidate('c', position)], 'c', TRIGGERS)).toEqual({ state: 'no_trigger_matched' })
    }
  })

  it('PLANTED: a trigger whose reason was never written gives none', () => {
    expect(resolveApprovedReason(ALL, 'c-award', TRIGGERS)).toEqual({ state: 'trigger_has_no_reason', triggerIndex: 3 })
  })

  it('PLANTED: no selected fact on record is not a pass', () => {
    expect(resolveApprovedReason(ALL, null, TRIGGERS)).toEqual({ state: 'no_selection' })
    expect(resolveApprovedReason(ALL, undefined, TRIGGERS)).toEqual({ state: 'no_selection' })
    expect(resolveApprovedReason(ALL, 'not-in-the-list', TRIGGERS)).toEqual({ state: 'no_selection' })
  })

  it('a client with no approved reason at all cannot be held to one, and is not', () => {
    expect(resolveApprovedReason(ALL, 'c-machine', null)).toEqual({ state: 'not_checked', why: 'no_trigger_list' })
    expect(resolveApprovedReason(ALL, 'c-machine', [])).toEqual({ state: 'not_checked', why: 'no_trigger_list' })
    expect(resolveApprovedReason(ALL, 'c-machine', [{ trigger: 'A thing happens.', reason: '  ' }]))
      .toEqual({ state: 'not_checked', why: 'no_trigger_has_a_reason' })
  })

  it('the writers argue from the approved sentence where there is one, and otherwise from what the caller had, untouched', () => {
    expect(reasonTheWritersArgueFrom({ state: 'approved', reason: 'R.', trigger: 't', triggerIndex: 1 }, 'a paraphrase')).toBe('R.')
    expect(reasonTheWritersArgueFrom({ state: 'not_checked', why: 'no_trigger_list' }, 'a paraphrase')).toBe('a paraphrase')
    expect(reasonTheWritersArgueFrom({ state: 'not_checked', why: 'no_trigger_list' }, undefined)).toBeUndefined()
    expect(reasonTheWritersArgueFrom({ state: 'no_trigger_matched' }, null)).toBeNull()
  })

  // FOUR since 2026-10-03: outside_definition, set after the definition check in
  // produce-opening (trigger-definition.test.ts), holds exactly as the other three do.
  it('the holding states are exactly the four where a list exists and gives this fact nothing', () => {
    expect([...HOLDING_STATES].sort()).toEqual(['no_selection', 'no_trigger_matched', 'outside_definition', 'trigger_has_no_reason'])
    expect(holdsPersonalisation({ state: 'approved', reason: 'r', trigger: 't', triggerIndex: 1 })).toBe(false)
    expect(holdsPersonalisation({ state: 'not_checked', why: 'no_trigger_list' })).toBe(false)
    for (const state of HOLDING_STATES) {
      expect(holdsPersonalisation({ state, triggerIndex: 1 } as never)).toBe(true)
    }
  })
})

const ctx: ProspectContext = {
  id: 'p1', organisation_id: 'org1', segment_id: null, first_name: 'Sam', last_name: null,
  company_name: 'Example Co', country: null, role: null, job_title: 'Owner', email: null,
  linkedin_url: null, website_url: null, company: null,
}

const template = (middle: string) => [
  '{{first_name}},', 'Most operators in this position find the same thing each quarter.', middle,
  'Does that match what you see?', 'Sam\nExample Co',
].join('\n\n')
const MESSAGING = {
  variants: { A: { emails: [
    { sequence_position: 2, body: template('The second email says how the work runs. It names no result.') },
    { sequence_position: 3, body: template('The third email looks at the same thing from another side.') },
  ] } },
} as never

const USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, calls: 0 }
const WIN = {
  opening: 'You installed a second machine in March. A second machine points to growth.',
  observation: 'You installed a second machine in March.', bridge: 'A second machine points to growth.',
  question: 'Is winning more orders part of the plan?', subject: null, written_won: true, retry_used: false,
  retries_used: 0, strong_material: false, judge_reasoning: 'send', usage: USAGE, comparisons: [], gate_failures: [], attempts: [],
}

beforeEach(() => {
  writeAndJudgeOpening.mockReset()
  writeFollowups.mockReset()
  checkBridgeStatesReason.mockReset()
  createMock.mockReset()
  writeAndJudgeOpening.mockResolvedValue(WIN)
  writeFollowups.mockResolvedValue({ email2: { prose: null, failures: [] }, email3: { prose: null, failures: [] }, usage: null, retries_used: 0, attempts: [] })
  checkBridgeStatesReason.mockResolvedValue({ verdict: { says: 'x', same: true, adds: [] }, failures: [], usage: USAGE, raw: '' })
  // The fact-check: no claims, so the closure reaches the reason check.
  createMock.mockResolvedValue({ content: [{ type: 'text', text: '{"claims":[]}' }], usage: { input_tokens: 1, output_tokens: 1 } })
})

const run = (selected: string | null, triggers: typeof TRIGGERS | null | undefined, extra: Record<string, unknown> = {}) => produceOpening({
  apiKey: 'k', clientName: 'Client', ctx, candidates: ALL, selectedCandidateId: selected, relevanceReason: 'R',
  prospectReason: 'The sentence synthesis wrote about this prospect, which the client never saw.',
  messagingContent: MESSAGING, variantId: 'A', triggers, ...extra,
})

describe('produceOpening holds personalisation with no approved reason behind it', () => {
  it.each([
    ['the selected fact matched no trigger', 'c-unmatched', 'no_trigger_matched'],
    ['the matched trigger carries no reason', 'c-award', 'trigger_has_no_reason'],
    ['no fact is recorded as selected', null, 'no_selection'],
  ])('PLANTED: %s: no opening, and the writer is never called', async (_name, selected, state) => {
    const out = await run(selected, TRIGGERS)
    expect(writeAndJudgeOpening).not.toHaveBeenCalled()
    expect(out).toMatchObject({
      not_written_reason: 'no_approved_reason', written_won: false, opening: null, question: null,
      judge_reasoning: NO_APPROVED_REASON_REASON, approved_reason: { state },
    })
    // Nothing was paid for, and no follow-up exists to point at an opening nobody received.
    expect(out.usage).toEqual(USAGE)
    expect(out.email2.prose).toBeNull()
    expect(writeFollowups).not.toHaveBeenCalled()
  })

  it('a client with no approved reasons is not held: the writer runs as it did before', async () => {
    const out = await run('c-unmatched', null)
    expect(writeAndJudgeOpening).toHaveBeenCalledTimes(1)
    expect(out.not_written_reason).toBeUndefined()
    expect(out.approved_reason).toEqual({ state: 'not_checked', why: 'no_trigger_list' })
    const params = writeAndJudgeOpening.mock.calls[0][0] as { prospectReason: string | null; reasonIsApproved: boolean }
    expect(params.prospectReason).toBe('The sentence synthesis wrote about this prospect, which the client never saw.')
    expect(params.reasonIsApproved).toBe(false)
  })
})

describe('the approved reason, verbatim, is what the writers argue from', () => {
  it('PLANTED: Email 1 is briefed with the approved sentence, not the one synthesis wrote', async () => {
    const out = await run('c-machine', TRIGGERS)
    const params = writeAndJudgeOpening.mock.calls[0][0] as { prospectReason: string | null; reasonIsApproved: boolean }
    expect(params.prospectReason).toBe('A second machine points to growth, and growth needs more orders.')
    expect(params.reasonIsApproved).toBe(true)
    // And what it was held to is on the result, so it lands in the stored record.
    expect(out.approved_reason).toMatchObject({ state: 'approved', triggerIndex: 1 })
  })

  it('PLANTED: the follow-ups argue from the same approved sentence', async () => {
    await run('c-machine', TRIGGERS, { writeFollowupEmails: true })
    expect(writeFollowups).toHaveBeenCalledTimes(1)
    expect((writeFollowups.mock.calls[0][0] as { prospectReason: string | null }).prospectReason)
      .toBe('A second machine points to growth, and growth needs more orders.')
  })

  it('PLANTED: the finished second line is read back against that sentence, and a rejection reaches the writer', async () => {
    await run('c-machine', TRIGGERS)
    const { factCheck } = writeAndJudgeOpening.mock.calls[0][0] as { factCheck: (c: { bridge: string; question: string }) => Promise<string[]> }
    checkBridgeStatesReason.mockResolvedValueOnce({ verdict: { says: '', same: false, adds: [] }, failures: ['the second line does not say what the approved reason says'], usage: USAGE, raw: '' })
    const failures = await factCheck({ bridge: 'A second machine needs a full order book by Monday.', question: 'Worth a short call?' })
    expect(checkBridgeStatesReason).toHaveBeenCalledTimes(1)
    expect(checkBridgeStatesReason.mock.calls[0][0]).toMatchObject({
      approvedReason: 'A second machine points to growth, and growth needs more orders.',
      bridge: 'A second machine needs a full order book by Monday.',
    })
    expect(failures).toEqual(['the second line does not say what the approved reason says'])
  })

  it('the reason check is not paid for on a line the fact-check already rejected', async () => {
    await run('c-machine', TRIGGERS)
    const { factCheck } = writeAndJudgeOpening.mock.calls[0][0] as { factCheck: (c: { bridge: string; question: string }) => Promise<string[]> }
    createMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"claims":[{"email":1,"claim":"a full order book","finding":null,"why":"no finding says so"}]}' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    const failures = await factCheck({ bridge: 'Your order book is full.', question: 'Worth a short call?' })
    expect(failures.length).toBeGreaterThan(0)
    expect(checkBridgeStatesReason).not.toHaveBeenCalled()
  })

  it('with no approved reason to hold the line to, the reason check does not run', async () => {
    await run('c-machine', null)
    const { factCheck } = writeAndJudgeOpening.mock.calls[0][0] as { factCheck: (c: { bridge: string; question: string }) => Promise<string[]> }
    await factCheck({ bridge: 'A second machine points to growth.', question: 'Worth a short call?' })
    expect(checkBridgeStatesReason).not.toHaveBeenCalled()
  })
})

describe('three hand-offs that could each be deleted without an error', () => {
  it('PLANTED: the reason check is billed inside the opening usage, with the fact-check beside it', async () => {
    // The check runs in a closure the WRITER calls, and its cost is folded into the result
    // after the writer returns. Dropped, the most recent verifier would be the one call per
    // attempt that nothing counts.
    checkBridgeStatesReason.mockResolvedValue({
      verdict: { says: 'x', same: true, adds: [] }, failures: [],
      usage: { input_tokens: 50, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, calls: 1 }, raw: '',
    })
    writeAndJudgeOpening.mockImplementation(async (params: { factCheck: (c: { bridge: string; question: string }) => Promise<string[]> }) => {
      await params.factCheck({ bridge: 'A second machine points to growth.', question: 'Worth a short call?' })
      return WIN
    })
    const out = await run('c-machine', TRIGGERS)
    // 1 token in and out from the fact-check stand-in, plus the reason check's 50 and 7.
    expect(out.usage).toMatchObject({ input_tokens: 51, output_tokens: 8, calls: 2 })
  })

  // SOURCE PINS for the two hops a behavioural test would need the whole agent stood in
  // for. The limit is the usual one: they prove the argument is passed, not that the path
  // runs. The batch path's hop is behavioural, in research-collect-snapshot.test.ts.
  const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8')

  it('PLANTED: the inline agent passes the client\'s triggers to the opening producer', () => {
    const agent = read('src/lib/agents/prospect-research-agent-v2.ts')
    expect(agent).toContain('await produceOpening({')   // the control
    expect(agent).toMatch(/triggers:\s*clientCtx\.triggers,/)
  })

  it('PLANTED: the writer is told when its reason is the approved one', () => {
    const writer = read('src/lib/agents/research/write-opening.ts')
    expect(writer).toContain('const assignment = buildWriterAssignment({')   // the control
    expect(writer).toMatch(/reasonIsApproved:\s*params\.reasonIsApproved \?\? false,/)
  })
})

describe('the fact-check may cite the approved reason', () => {
  it('PLANTED: the approved reason is one more numbered line, labelled as general and not about this reader', () => {
    const evidence = evidenceWithApprovedReason([MACHINE, SITE], 'A second machine points to growth, and growth needs more orders.')
    const lines = evidence.split('\n')
    expect(lines[0]).toMatch(/^1\. /)
    expect(lines[2]).toMatch(/^2\. /)
    expect(lines[4]).toBe(
      '3. A general statement, approved in advance. It is true of firms in general and is NOT a finding about this reader: ' +
      'A second machine points to growth, and growth needs more orders.',
    )
    expect(lines[5]).toBe('   source: approved in advance | not research about this reader')
  })

  it('with no approved reason the evidence is the findings and nothing else', () => {
    const evidence = evidenceWithApprovedReason([MACHINE, SITE], null)
    expect(evidence.split('\n').filter(l => /^\d+\. /.test(l))).toHaveLength(2)
    expect(evidence).not.toContain('approved in advance')
  })

  it('PLANTED: the fact-check is handed that evidence when there is an approved reason, and only then', async () => {
    await run('c-machine', TRIGGERS)
    const { factCheck } = writeAndJudgeOpening.mock.calls[0][0] as { factCheck: (c: { bridge: string; question: string }) => Promise<string[]> }
    await factCheck({ bridge: 'A second machine points to growth.', question: 'Worth a short call?' })
    const user = (createMock.mock.calls[0][0] as { messages: Array<{ content: string }> }).messages[0].content
    expect(user).toContain('A general statement, approved in advance.')
    expect(user).toContain('A second machine points to growth, and growth needs more orders.')

    writeAndJudgeOpening.mockClear(); createMock.mockClear()
    await run('c-machine', null)
    const second = writeAndJudgeOpening.mock.calls[0][0] as { factCheck: (c: { bridge: string; question: string }) => Promise<string[]> }
    await second.factCheck({ bridge: 'A second machine points to growth.', question: 'Worth a short call?' })
    const plain = (createMock.mock.calls[0][0] as { messages: Array<{ content: string }> }).messages[0].content
    expect(plain).not.toContain('approved in advance')
  })
})

describe('the assignment block', () => {
  const base = { clientName: 'Client', buyer: 'an owner', prospectReason: 'A second machine points to growth, and growth needs more orders.' }

  it('PLANTED: says the reason is approved, and that the second line may not say more than it', () => {
    const block = buildWriterAssignment({ ...base, reasonIsApproved: true })
    expect(block).toContain('A second machine points to growth, and growth needs more orders.')
    expect(block).toContain(APPROVED_REASON_HEADING)
    expect(block).toContain('Your second line is that reason, pointed at this event.')
    expect(block).toContain('A second line that says more than the reason\nsays, or says something else, is rejected.')
  })

  it('PLANTED: the second line states what the event points to, and the question asks about what that needs', () => {
    // The split that makes the line about the firm\'s direction and not about a task. On the
    // trial that lacked it the writer kept the second half of the reason and dropped the first.
    const block = buildWriterAssignment({ ...base, reasonIsApproved: true })
    expect(block).toContain('your\nsecond line states the FIRST part and stops. Your closing question asks about the SECOND.')
  })

  it('PLANTED: says it about firms in general, the form the fact-check accepts', () => {
    const block = buildWriterAssignment({ ...base, reasonIsApproved: true })
    expect(block).toContain('Say it about firms in general: "a firm" or "firms". Never "the firm", and never "your".')
  })

  it('names the sender nowhere in the added text, and carries no example sentence to copy', () => {
    // The first wording called the reason "the client\'s own". Two of eight trial openings
    // then wrote the SENDER\'s name into the reader\'s email.
    const added = buildWriterAssignment({ ...base, reasonIsApproved: true }).split(APPROVED_REASON_HEADING)[1]
    expect(added).not.toMatch(/client/i)
    expect(added).not.toMatch(/for example|e\.g\./i)
  })

  it('says nothing of the kind about a reason synthesis wrote', () => {
    const block = buildWriterAssignment({ ...base, reasonIsApproved: false })
    expect(block).toContain(base.prospectReason)
    expect(block).not.toContain(APPROVED_REASON_HEADING)
    expect(buildWriterAssignment(base)).not.toContain(APPROVED_REASON_HEADING)
  })

  it('and nothing at all when there is no reason', () => {
    expect(buildWriterAssignment({ clientName: 'Client', buyer: 'an owner', reasonIsApproved: true })).not.toContain(APPROVED_REASON_HEADING)
  })
})
