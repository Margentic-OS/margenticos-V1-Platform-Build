// THE EMAIL 1 QUESTION TIES BACK TO THE HOOK. Operator instruction, 2026-10-03.
//
// He read an Email 1 whose observation named one thing and whose closing question asked about
// something else: a reader finishing it could not see why they were being asked. The floor
// check already reads the finished email cold, so it now answers a second question about the
// question, with no new model call, and a NO fails the attempt the way a private-knowledge
// claim does: a retry with the reason quoted back, then the approved template.
//
// DRIVES THE REAL writeAndJudgeOpening against a scripted model.
// RULE ZERO. Every fixture is invented and industry-neutral.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const createMock = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({
  default: class { messages = { create: createMock } },
}))

import { writeAndJudgeOpening, buildFloorPrompt, parseFloor, buildWriterPrompt } from '../write-opening'
import type { ObservationCandidate } from '../types'

const CANDIDATE = {
  id: 'c1',
  observation: 'Two locations were added and four roles listed in the same month.',
  source: 'web',
  provenance: 'a public listings page',
  score_total: 6,
  passes_all: false,
} as unknown as ObservationCandidate

const OBSERVATION = 'Two locations were added and four roles listed in the same month.'
const BRIDGE = 'The filling of them lands before the work that pays for it.'
const QUESTION = 'Is closing that gap something you are looking at?'
const TEMPLATE_OPENING = 'The authored opener.'
const UNTIED = 'the question asks about the market in general, not the two new locations'

const say = (text: string) => ({ content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } })

const writerReply = () => say([
  `OBSERVATION: ${OBSERVATION}`,
  `BRIDGE: ${BRIDGE}`,
  `QUESTION: ${QUESTION}`,
  'SUBJECT: two locations, four roles',
].join('\n'))

const FLOOR_PASS = 'CLAIMS_PRIVATE: NO\nREASON: everything here is visible from outside.\nQUESTION_TIES_BACK: YES\nQUESTION_REASON: it asks about the new locations.'
const FLOOR_UNTIED = `CLAIMS_PRIVATE: NO\nREASON: everything here is visible from outside.\nQUESTION_TIES_BACK: NO\nQUESTION_REASON: ${UNTIED}.`

/** The floor answers from `floors` in turn (the last one repeats); the judge prefers the written email. */
function script(floors: string[]) {
  let n = 0
  createMock.mockImplementation(async (args: { system: unknown; messages: { content: string }[] }) => {
    if (Array.isArray(args.system)) return writerReply()
    const content = String(args.messages[0].content)
    if (!content.includes('VERSION A')) return say(floors[Math.min(n++, floors.length - 1)])
    const writtenIsA = !content.split('VERSION B')[0].includes(TEMPLATE_OPENING)
    return say(`CHOICE: ${writtenIsA ? 'A' : 'B'}\nREASON: it reads faster.`)
  })
}

const writerPrompts = () =>
  createMock.mock.calls.filter(([a]) => Array.isArray(a.system)).map(([a]) => String(a.messages[0].content))

const run = () => writeAndJudgeOpening({
  apiKey: 'test-key',
  clientName: 'Test Client',
  buyer: 'the person reading it',
  prospectFirstName: 'Robin',
  candidates: [CANDIDATE],
  p3: 'We keep the work arriving without you chasing it.',
  templateOpening: TEMPLATE_OPENING,
  composeEmail1: (opening, question, subj) =>
    `Subject: ${subj ?? 'a note about capacity'}\n\nRobin\n\n${opening}\n\n${question ?? 'Worth a short conversation?'}`,
  prospectId: 'p1',
})

beforeEach(() => {
  createMock.mockReset()
  vi.spyOn(Math, 'random').mockReturnValue(0.1)
})
afterEach(() => vi.restoreAllMocks())

describe('the floor asks whether the question ties back to the observation', () => {
  it('asks it in the existing floor prompt and names the answer field', () => {
    const p = buildFloorPrompt().replace(/\s+/g, ' ')
    expect(p).toContain('QUESTION_TIES_BACK')
    expect(p).toContain("in the reader's own terms")
  })

  it('reads YES as tied back', () => {
    expect(parseFloor(FLOOR_PASS).question_ties_back).toBe(true)
  })

  it('reads NO as not tied back, keeping its reason', () => {
    const f = parseFloor(FLOOR_UNTIED)
    expect(f.question_ties_back).toBe(false)
    expect(f.question_reason).toContain(UNTIED)
    // The knowability verdict is unchanged by the second answer.
    expect(f.claims_private).toBe(false)
  })

  it('FAILS CLOSED when the answer is missing the field', () => {
    expect(parseFloor('CLAIMS_PRIVATE: NO\nREASON: everything here is visible from outside.').question_ties_back).toBe(false)
    expect(parseFloor('').question_ties_back).toBe(false)
  })
})

describe('a question that does not tie back fails the attempt', () => {
  it('CONTROL: a floor that passes both lets the written email ship', async () => {
    script([FLOOR_PASS])
    const r = await run()
    expect(r.written_won).toBe(true)
  })

  it('RETRIES with the reason quoted to the writer, and ships once it ties back', async () => {
    script([FLOOR_UNTIED, FLOOR_PASS])
    const r = await run()
    const prompts = writerPrompts()
    expect(prompts.length).toBe(2)
    expect(prompts[1]).toContain(UNTIED)
    expect(r.written_won).toBe(true)
  })

  it('FALLS BACK to the template when it never ties back, and says why', async () => {
    script([FLOOR_UNTIED])
    const r = await run()
    expect(r.written_won).toBe(false)
    expect(r.opening).toBeNull()
    expect(r.judge_reasoning).toContain('closing question does not tie back')
    expect(r.judge_reasoning).toContain(UNTIED)
  })
})

describe('the writer is told the question ties back to the observation', () => {
  it('says the question asks about what the observation names, in the reader terms', () => {
    const p = buildWriterPrompt().replace(/\s+/g, ' ')
    expect(p).toContain('THE QUESTION TIES BACK TO THE OBSERVATION')
    expect(p).toContain('asks about the thing your observation names')
  })
})
