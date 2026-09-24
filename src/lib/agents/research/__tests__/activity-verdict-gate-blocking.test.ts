// THE ABSENCE GATE, BLOCKING. What a prospect gets when every attempt names what they lack.
//
// ACTIVITY_VERDICT_MODE was flipped from 'report' to 'block' on 2026-09-16. Report mode
// logged 24 hits across 246 attempts and let all of them through; two reached real
// prospects and both were genuine violations. See src/lib/style/activity-verdict.ts for
// the evidence, and the Notion Backlog row for every hit verbatim.
//
// THE CLAIM THIS FILE PROVES, and it is the one that made the flip safe to make: a gated
// prospect does not fail. It retries, and when every attempt is gated it returns a null
// opening, which composition already treats as "use the variant's authored opener".
//
// The three links in that chain are proven in three places, deliberately:
//
//   1. banned copy -> a gate failure          here, and in style/__tests__/activity-verdict
//   2. all attempts gated -> opening: null    here, against the real loop
//   3. opening: null -> authored opener ships composition/__tests__/compose-sequence
//
// Fixtures are industry-neutral and none is copied from the writer's prompt. The banned
// observation is the SHAPE that shipped, not the sentence: a real one carries numbers that
// would trip the traceability gate too, and a proof wants one reason, not two.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const createMock = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: createMock }
  },
}))

import { writeAndJudgeOpening } from '../write-opening'
import type { ObservationCandidate } from '../types'

const FINDINGS_TEXT = 'Vantor added two locations and listed four open roles in the same month.'

const CANDIDATE: ObservationCandidate = {
  id: 'c1',
  observation: FINDINGS_TEXT,
  source: 'web',
  provenance: 'a public listings page',
  score_total: 6,
  passes_all: false,
} as unknown as ObservationCandidate

/** Lists what is missing from their site. The ban names this shape explicitly. */
const OBSERVATION_BANNED = 'Your site carries no dated case studies and no new material.'
/** The same fact about the same site, stated as what IS there. */
const OBSERVATION_CLEAN = 'Two locations were added and four roles listed in the same month.'
const BRIDGE = 'The filling of them lands before the work that pays for it.'
const QUESTION = 'Is closing that gap something you are looking at?'
const SUBJECT = 'two locations, four roles'

const say = (text: string) => ({
  content: [{ type: 'text', text }],
  usage: { input_tokens: 1, output_tokens: 1 },
})

const writerReply = (observation: string) => say([
  `OBSERVATION: ${observation}`,
  `BRIDGE: ${BRIDGE}`,
  `QUESTION: ${QUESTION}`,
  `SUBJECT: ${SUBJECT}`,
].join('\n'))

const FLOOR_PASS = say('CLAIMS_PRIVATE: NO\nREASON: everything here is visible from outside.')
const TEMPLATE_OPENING = 'The authored opener.'

const writerCalls = () =>
  createMock.mock.calls.filter(([args]) => Array.isArray(args.system)).length

/** Every writer call returns the same observation; the judge always prefers the written one. */
function script(observation: string) {
  createMock.mockImplementation(async (args: { system: unknown; messages: { content: string }[] }) => {
    if (Array.isArray(args.system)) return writerReply(observation)
    const content = String(args.messages[0].content)
    if (!content.includes('VERSION A')) return FLOOR_PASS
    const writtenIsA = !content.split('VERSION B')[0].includes(TEMPLATE_OPENING)
    return say(`CHOICE: ${writtenIsA ? 'A' : 'B'}\nREASON: the written one is more specific.`)
  })
}

function run() {
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
  })
}

beforeEach(() => {
  createMock.mockReset()
  vi.spyOn(Math, 'random').mockReturnValue(0.1)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the absence gate, blocking, against the real attempt loop', () => {
  it('a prospect gated on every attempt returns a null opening rather than failing', async () => {
    script(OBSERVATION_BANNED)
    const result = await run()

    // The whole point. Not a throw, not a rejected promise, not an error field.
    expect(result.opening).toBeNull()
    expect(result.observation).toBeNull()
    expect(result.bridge).toBeNull()
    expect(result.question).toBeNull()
    expect(result.written_won).toBe(false)

    // It tried, and it used EVERY attempt it had before giving up.
    //
    // Asserted as an invariant rather than as a number, because the number is not fixed:
    // `maxAttempts = strongMaterial ? 3 : 2` in write-opening.ts, and this fixture's
    // candidate is deliberately weak material (passes_all: false), so it gets 2. Pinning
    // 3 here would be pinning a property of the fixture and calling it a property of the
    // gate. What matters is that no attempt was skipped and the loop did not bail early.
    expect(writerCalls()).toBe(result.retries_used + 1)
    expect(writerCalls()).toBeGreaterThan(1)

    // And it says why, in words an operator can act on.
    expect(result.gate_failures.length).toBeGreaterThan(0)
    expect(result.gate_failures.join(' ')).toContain('names what they lack')
  })

  it('MUTATION PROOF: the same run with a permitted observation is not gated', async () => {
    // Identical script, identical fixtures, one sentence changed from naming an absence to
    // naming what is there. If this goes red the gate is rejecting permitted copy, and if
    // the test above goes green while this one does too the gate is not the reason either.
    script(OBSERVATION_CLEAN)
    const result = await run()

    expect(result.opening).not.toBeNull()
    expect(result.gate_failures.join(' ')).not.toContain('names what they lack')
    expect(writerCalls()).toBe(1)
  })
})
