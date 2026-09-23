// A REPEATED BRIDGE NO LONGER COSTS A PROSPECT THEIR EMAIL.
//
// This is the end-to-end half of the block-to-report change, against the REAL attempt loop.
// The unit tests on BatchUniquenessRegistry prove reserve() reports and records; they cannot
// prove that writeAndJudgeOpening acts on the report rather than aborting, and that was the
// whole defect: on 2026-09-23 Jason Shapiro and Richard Spilsbury each had their email
// thrown away on every attempt over a bridge frame another prospect reserved first, both
// with strong_material logged.
//
// MUTATION TARGET. Reinstating the block at the call site in write-opening.ts must turn the
// first test here red. That is what the test is for.
//
// Fixtures are industry-neutral and no sentence is lifted from the writer's prompt.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const createMock = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: createMock }
  },
}))

import { writeAndJudgeOpening } from '../write-opening'
import { BatchUniquenessRegistry } from '../batch-uniqueness'
import type { ObservationCandidate } from '../types'

const CANDIDATE: ObservationCandidate = {
  id: 'c1',
  observation: 'Two locations were added and four roles listed in the same month.',
  source: 'web',
  provenance: 'a public listings page',
  date: '2026-08-02',
  score_total: 6,
  passes_all: false,
} as unknown as ObservationCandidate

const OBSERVATION = 'Two locations were added and four roles listed in the same month.'
/** The bridge a DIFFERENT prospect will have reserved first. */
const SHARED_BRIDGE = 'The filling of them lands before the work that pays for it.'
const QUESTION = 'Is closing that gap something you are looking at?'
const SUBJECT = 'two locations, four roles'
const TEMPLATE_OPENING = 'The authored opener.'

const say = (text: string) => ({
  content: [{ type: 'text', text }],
  usage: { input_tokens: 1, output_tokens: 1 },
})

const FLOOR_PASS = say('CLAIMS_PRIVATE: NO\nREASON: everything here is visible from outside.')

function script(bridge: string) {
  createMock.mockImplementation(async (args: { system: unknown; messages: { content: string }[] }) => {
    if (Array.isArray(args.system)) {
      return say([`OBSERVATION: ${OBSERVATION}`, `BRIDGE: ${bridge}`, `QUESTION: ${QUESTION}`, `SUBJECT: ${SUBJECT}`].join('\n'))
    }
    const content = String(args.messages[0].content)
    if (!content.includes('VERSION A')) return FLOOR_PASS
    const writtenIsA = !content.split('VERSION B')[0].includes(TEMPLATE_OPENING)
    return say(`CHOICE: ${writtenIsA ? 'A' : 'B'}\nREASON: the written one is more specific.`)
  })
}

function run(uniqueness?: BatchUniquenessRegistry) {
  return writeAndJudgeOpening({
    apiKey: 'test-key',
    clientName: 'Test Client',
    buyer: 'the person reading it',
    prospectFirstName: 'Robin',
    candidates: [CANDIDATE],
    selectedCandidateId: 'c1',
    p3: 'We keep the work arriving without you chasing it.',
    cta: 'Worth a short conversation?',
    templateOpening: TEMPLATE_OPENING,
    composeEmail1: (opening, question, subj) =>
      `Subject: ${subj ?? 'a note about capacity'}\n\nRobin\n\n${opening}\n\n${question ?? 'Worth a short conversation?'}`,
    prospectId: 'p2',
    uniqueness,
    now: new Date('2026-09-23T12:00:00Z'),
  })
}

beforeEach(() => {
  createMock.mockReset()
  vi.spyOn(Math, 'random').mockReturnValue(0.1)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a bridge another prospect already used', () => {
  it('SHIPS ANYWAY. This is the test the block must break.', async () => {
    const reg = new BatchUniquenessRegistry()
    reg.reserve('p1', SHARED_BRIDGE, 'A different closing question entirely?')
    script(SHARED_BRIDGE)

    const result = await run(reg)

    expect(result.written_won).toBe(true)
    expect(result.opening).toContain(OBSERVATION)
    expect(result.opening).toContain(SHARED_BRIDGE)
  })

  it('is recorded as a collision, so the batch tally can count it', async () => {
    const reg = new BatchUniquenessRegistry()
    reg.reserve('p1', SHARED_BRIDGE, 'A different closing question entirely?')
    script(SHARED_BRIDGE)

    await run(reg)

    expect(reg.reportedCollisions.length).toBeGreaterThan(0)
    expect(reg.reportedCollisions.every(c => c.firstSeenId === 'p1')).toBe(true)
  })

  it('does not burn a retry on it: one writer call, not three', async () => {
    const reg = new BatchUniquenessRegistry()
    reg.reserve('p1', SHARED_BRIDGE, 'A different closing question entirely?')
    script(SHARED_BRIDGE)

    await run(reg)

    const writerCalls = createMock.mock.calls.filter(([a]) => Array.isArray(a.system)).length
    expect(writerCalls).toBe(1)
  })

  // POSITIVE CONTROL. Without a prior reservation the same copy also ships, so the first
  // test is not passing because collisions are impossible to create in this harness.
  it('CONTROL: the same copy ships with nothing reserved, and reports no collision', async () => {
    const reg = new BatchUniquenessRegistry()
    script(SHARED_BRIDGE)

    const result = await run(reg)

    expect(result.written_won).toBe(true)
    expect(reg.reportedCollisions).toHaveLength(0)
  })
})
