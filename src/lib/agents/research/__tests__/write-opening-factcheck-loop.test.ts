// THE EMAIL 1 FACT-CHECK AS A GATE IN THE REAL ATTEMPT LOOP.
//
// fact-check-opening.test.ts proves the code half decides correctly given a verdict. This
// proves the verdict is ACTED ON: a failure is retried with the failure quoted back to the
// writer, and copy that never clears it falls back to the approved template rather than
// shipping. A checker whose result nothing consumes is the shape this project keeps finding,
// so the wiring is asserted rather than assumed.
//
// DRIVES THE REAL writeAndJudgeOpening against a scripted model. Nothing about the decision is
// restated here.
//
// RULE ZERO. Every fixture is invented and industry-neutral.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const createMock = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: createMock }
  },
}))

import { writeAndJudgeOpening, type AttemptObservation } from '../write-opening'
import type { ObservationCandidate } from '../types'

const CANDIDATE: ObservationCandidate = {
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

const FAILURE = 'Email 1 states "the work that pays for it", which the findings do not support: no finding describes their revenue.'

const say = (text: string) => ({
  content: [{ type: 'text', text }],
  usage: { input_tokens: 1, output_tokens: 1 },
})

const writerReply = () => say([
  `OBSERVATION: ${OBSERVATION}`,
  `BRIDGE: ${BRIDGE}`,
  `QUESTION: ${QUESTION}`,
  `SUBJECT: two locations, four roles`,
].join('\n'))

const FLOOR_PASS = say('CLAIMS_PRIVATE: NO\nREASON: everything here is visible from outside.')

function script() {
  createMock.mockImplementation(async (args: { system: unknown; messages: { content: string }[] }) => {
    if (Array.isArray(args.system)) return writerReply()
    const content = String(args.messages[0].content)
    if (!content.includes('VERSION A')) return FLOOR_PASS
    const writtenIsA = !content.split('VERSION B')[0].includes(TEMPLATE_OPENING)
    return say(`CHOICE: ${writtenIsA ? 'A' : 'B'}\nREASON: it reads faster.`)
  })
}

/** Every user message sent to the WRITER, which is the only call with an array system block. */
const writerPrompts = () =>
  createMock.mock.calls
    .filter(([a]) => Array.isArray(a.system))
    .map(([a]) => String(a.messages[0].content))

function run(
  factCheck?: (copy: { bridge: string; question: string }) => Promise<string[]>,
  onAttempt?: (o: AttemptObservation) => void,
) {
  return writeAndJudgeOpening({
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
    factCheck,
    onAttempt,
  })
}

beforeEach(() => {
  createMock.mockReset()
  script()
  vi.spyOn(Math, 'random').mockReturnValue(0.1)
})
afterEach(() => vi.restoreAllMocks())

describe('the Email 1 fact-check gates, retries and falls back', () => {
  it('CONTROL: with no fact-check the copy ships, so the failures below mean something', async () => {
    const r = await run()
    expect(r.written_won).toBe(true)
    expect(r.opening).toContain(BRIDGE)
  })

  it('CONTROL: a fact-check that passes does not change the outcome', async () => {
    const r = await run(async () => [])
    expect(r.written_won).toBe(true)
    expect(r.opening).toContain(BRIDGE)
  })

  it('RETRIES with the failure QUOTED back to the writer', async () => {
    let calls = 0
    // Fails the first attempt only, so the retry has somewhere to land.
    const r = await run(async () => (++calls === 1 ? [FAILURE] : []))

    const prompts = writerPrompts()
    expect(prompts.length).toBeGreaterThan(1)
    // The second writer prompt must carry the reason verbatim, not a summary of it.
    expect(prompts[1]).toContain(FAILURE)
    // And the copy it rejected, so the model can see what it wrote.
    expect(prompts[1]).toContain(BRIDGE)
    expect(r.written_won).toBe(true)
  })

  it('FALLS BACK to the template when every attempt fails the fact-check', async () => {
    const r = await run(async () => [FAILURE])
    expect(r.written_won).toBe(false)
    // Nothing that failed the check may reach the prospect.
    expect(r.opening ?? '').not.toContain(BRIDGE)
  })

  it('is given the BRIDGE and the QUESTION, and nothing else', async () => {
    const seen: { bridge: string; question: string }[] = []
    await run(async copy => { seen.push(copy); return [] })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[0].bridge).toBe(BRIDGE)
    expect(seen[0].question).toBe(QUESTION)
  })

  /**
   * A rejected attempt must be READABLE afterwards. Recording the kind without the reason
   * would put "rejected, no reason given" into writer_attempts, which is the exact gap that
   * column exists to close.
   */
  it('records the attempt as factchecked WITH its reason', async () => {
    const seen: AttemptObservation[] = []
    await run(async () => [FAILURE], o => seen.push(o))
    const fc = seen.filter(o => o.kind === 'factchecked')
    expect(fc.length).toBeGreaterThan(0)
    expect(fc[0].gate_failures).toContain(FAILURE)
  })

  it('does not pay for the fact-check on an attempt the deterministic gates already rejected', async () => {
    // A bridge naming the prospect is a deterministic gate failure.
    createMock.mockImplementation(async (args: { system: unknown; messages: { content: string }[] }) => {
      if (Array.isArray(args.system)) {
        return say([
          `OBSERVATION: ${OBSERVATION}`,
          'BRIDGE: The filling of them is the part Robin carries alone.',
          `QUESTION: ${QUESTION}`,
          'SUBJECT: two locations, four roles',
        ].join('\n'))
      }
      const content = String(args.messages[0].content)
      if (!content.includes('VERSION A')) return FLOOR_PASS
      return say('CHOICE: B\nREASON: it reads faster.')
    })

    let called = 0
    await run(async () => { called++; return [] })
    expect(called).toBe(0)
  })
})
