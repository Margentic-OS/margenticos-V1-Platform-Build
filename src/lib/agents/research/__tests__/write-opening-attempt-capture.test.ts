// WHAT A REJECTED ATTEMPT LEAVES BEHIND.
//
// The attempt loop reports one AttemptObservation per iteration. It used to carry the
// attempt index, the kind and the gate codes, and nothing else. The observation, the
// bridge, the question and the subject lived in a local inside the loop and were
// overwritten by the next attempt, so a prospect that fell back to the approved template
// left a verdict with no text behind it: the failure could be COUNTED and not READ. Four
// prospects fell back in the last run and none of their losing copy survives anywhere.
//
// These tests drive the real loop against a scripted model and assert the text of every
// attempt is reported, the rejected ones included, along with the judge's verdict on every
// comparison rather than on the last one only.
//
// THE LAST TEST IS THE ONE THAT PROTECTS PRODUCTION. onAttempt is optional and both
// production callers omit it, so the claim that this changes nothing they do is a claim
// about equality between a run with the callback and a run without. It is asserted rather
// than stated.
//
// Fixtures are invented and industry-neutral, and none is copied from the prompt.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const createMock = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: createMock }
  },
}))

import { writeAndJudgeOpening, type AttemptObservation } from '../write-opening'
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

const OBSERVATION = 'Two locations were added and four roles listed in the same month.'
const BRIDGE_CLEAN = 'The filling of them lands before the work that pays for it. That order is uncomfortable.'
// Names the prospect, which is a deterministic gate. Everything else about it is fine, so
// the attempt is rejected with all four blocks present and readable.
const BRIDGE_GATED = 'The filling of them is the part Robin carries alone. That order is uncomfortable.'
const QUESTION = 'Is closing that gap something you are looking at?'
const SUBJECT_OK = 'two locations, four roles'
// Nothing in the findings supports it, so the subject's own soft gate discards it. The
// attempt is NOT rejected: an unusable subject is free by design.
const SUBJECT_UNTRACEABLE = 'the Harrowgate rollout'

const say = (text: string) => ({
  content: [{ type: 'text', text }],
  usage: { input_tokens: 1, output_tokens: 1 },
})

const writerReply = (bridge: string, subject: string) => say([
  `OBSERVATION: ${OBSERVATION}`,
  `BRIDGE: ${bridge}`,
  `QUESTION: ${QUESTION}`,
  `SUBJECT: ${subject}`,
].join('\n'))

const FLOOR_PASS = say('CLAIMS_PRIVATE: NO\nREASON: everything here is visible from outside.')

const TEMPLATE_OPENING = 'The authored opener.'

/** Counts writer calls by the only thing that distinguishes them: the cached system block. */
const writerCalls = () =>
  createMock.mock.calls.filter(([args]) => Array.isArray(args.system)).length

/**
 * Scripts the model for a run. `writerReplies` is consumed one per writer call; the last
 * entry repeats if the loop asks for more.
 *
 * The judge is scripted by SIDE rather than by letter, because the written version is
 * labelled A or B at random. `verdicts` is consumed one per comparison: true means the
 * judge picks the written version.
 */
function script(writerReplies: ReturnType<typeof say>[], verdicts: boolean[], reasons: string[]) {
  let w = 0
  let j = 0
  createMock.mockImplementation(async (args: { system: unknown; messages: { content: string }[] }) => {
    if (Array.isArray(args.system)) return writerReplies[Math.min(w++, writerReplies.length - 1)]
    const content = String(args.messages[0].content)
    if (!content.includes('VERSION A')) return FLOOR_PASS
    const writtenIsA = !content.split('VERSION B')[0].includes(TEMPLATE_OPENING)
    const wantWritten = verdicts[Math.min(j, verdicts.length - 1)]
    const reason = reasons[Math.min(j, reasons.length - 1)]
    j++
    const pick = wantWritten === writtenIsA ? 'A' : 'B'
    return say(`CHOICE: ${pick}\nREASON: ${reason}`)
  })
}

function run(onAttempt?: (o: AttemptObservation) => void) {
  return writeAndJudgeOpening({
    apiKey: 'test-key',
    clientName: 'Test Client',
    buyer: 'the person reading it',
    prospectFirstName: 'Robin',
    candidates: [CANDIDATE],
    p3: 'We keep the work arriving without you chasing it.',
    cta: 'Worth a short conversation?',
    templateOpening: TEMPLATE_OPENING,
    composeEmail1: (opening, question, subj) =>
      `Subject: ${subj ?? 'a note about capacity'}\n\nRobin\n\n${opening}\n\n${question ?? 'Worth a short conversation?'}`,
    prospectId: 'p1',
    onAttempt,
  })
}

beforeEach(() => {
  createMock.mockReset()
  // The written version's A/B label is randomised per comparison. Pinned so two runs of
  // the same script produce deep-equal results, which the last test depends on.
  vi.spyOn(Math, 'random').mockReturnValue(0.1)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a rejected attempt reports the words that failed', () => {
  it('carries the observation, bridge and question of an attempt the gates threw away', async () => {
    script(
      [writerReply(BRIDGE_GATED, SUBJECT_OK), writerReply(BRIDGE_CLEAN, SUBJECT_OK)],
      [true],
      ['it reads faster.'],
    )

    const attempts: AttemptObservation[] = []
    const result = await run(o => attempts.push(o))

    expect(result.written_won).toBe(true)
    expect(attempts).toHaveLength(2)

    // THE ATTEMPT THAT DID NOT SHIP. Before this change the next three assertions had
    // nothing to read: the observation and the bridge were not on the union at all.
    const rejected = attempts[0]
    expect(rejected.kind).toBe('gated')
    expect(rejected.gate_failures.join(' ')).toContain('names the prospect')
    expect(rejected.observation).toBe(OBSERVATION)
    expect(rejected.bridge).toBe(BRIDGE_GATED)
    expect(rejected.question).toBe(QUESTION)

    // And the attempt that did ship, so the pair can be read side by side.
    expect(attempts[1].kind).toBe('compared')
    expect(attempts[1].bridge).toBe(BRIDGE_CLEAN)
  })

  it('reports the subject its own soft gate discarded, distinctly from having none', async () => {
    script([writerReply(BRIDGE_CLEAN, SUBJECT_UNTRACEABLE)], [true], ['it reads faster.'])

    const attempts: AttemptObservation[] = []
    const result = await run(o => attempts.push(o))

    // The soft gate is free: one writer call, no retry, and the authored subject ships.
    expect(writerCalls()).toBe(1)
    expect(result.subject).toBeNull()

    // An empty `subject` alone cannot say WHY it is empty. This is what tells the two
    // apart, and the discarded text is the diagnostic material the log line cannot return.
    expect(attempts[0].subject).toBe('')
    expect(attempts[0].subject_discarded).toBe(SUBJECT_UNTRACEABLE)
  })

  it('reports null rather than empty when the writer returned no subject at all', async () => {
    script([writerReply(BRIDGE_CLEAN, SUBJECT_OK)], [true], ['it reads faster.'])

    const attempts: AttemptObservation[] = []
    await run(o => attempts.push(o))

    expect(attempts[0].subject).toBe(SUBJECT_OK)
    expect(attempts[0].subject_discarded).toBeNull()
  })
})

describe("every comparison's reasoning survives, not only the final one", () => {
  it('reports the judge verdict on each attempt that reached one', async () => {
    script(
      [writerReply(BRIDGE_CLEAN, SUBJECT_OK), writerReply(BRIDGE_CLEAN, SUBJECT_OK)],
      [false, true],
      ['the authored version lands the ask sooner.', 'this one reads faster.'],
    )

    const attempts: AttemptObservation[] = []
    const result = await run(o => attempts.push(o))

    expect(attempts).toHaveLength(2)
    expect(attempts[0].kind).toBe('compared')
    expect(attempts[0].judge_written_won).toBe(false)
    // THE VERDICT THAT USED TO BE UNREACHABLE. OpeningResult.judge_reasoning carries the
    // final comparison only, so this sentence was overwritten by the rewrite's verdict.
    expect(attempts[0].judge_reasoning).toBe('the authored version lands the ask sooner.')
    expect(attempts[1].judge_written_won).toBe(true)
    expect(attempts[1].judge_reasoning).toBe('this one reads faster.')

    // The loop already kept both comparisons. The export is what reduced them to a count.
    expect(result.comparisons.map(c => c.reason)).toEqual([
      'the authored version lands the ask sooner.',
      'this one reads faster.',
    ])
    expect(result.judge_reasoning).toBe('this one reads faster.')
  })

  it('reports null reasoning for an attempt that never reached the judge', async () => {
    script(
      [writerReply(BRIDGE_GATED, SUBJECT_OK), writerReply(BRIDGE_CLEAN, SUBJECT_OK)],
      [true],
      ['it reads faster.'],
    )

    const attempts: AttemptObservation[] = []
    await run(o => attempts.push(o))

    // An absent verdict and a verdict of "no reasoning returned" are different facts.
    expect(attempts[0].judge_reasoning).toBeNull()
    expect(attempts[0].judge_written_won).toBeNull()
  })
})

describe('the callback is observation only, so production is unchanged', () => {
  it('produces an identical result and identical model calls with and without it', async () => {
    const scriptIt = () => script(
      [writerReply(BRIDGE_GATED, SUBJECT_UNTRACEABLE), writerReply(BRIDGE_CLEAN, SUBJECT_OK)],
      [true],
      ['it reads faster.'],
    )

    scriptIt()
    const withCallback = await run(() => {})
    const callsWith = createMock.mock.calls.length

    createMock.mockReset()
    scriptIt()
    // EXACTLY WHAT BOTH PRODUCTION CALLERS DO: omit it entirely.
    const without = await run()
    const callsWithout = createMock.mock.calls.length

    expect(without).toEqual(withCallback)
    expect(callsWithout).toBe(callsWith)
  })
})
