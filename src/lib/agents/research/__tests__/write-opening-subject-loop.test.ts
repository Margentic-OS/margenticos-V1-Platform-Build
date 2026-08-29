// The property the whole subject feature depends on: an unusable subject is FREE.
//
// The attempt loop gives a prospect two tries, or three when the findings are strong. Each
// one is a writer call, and an exhausted loop ships the client's approved template. So a
// subject failure charged to that budget would buy a subject with a retry the BODY needed,
// and the body is what the reply comes from. These tests drive the real loop against a
// scripted model and count the writer calls.
//
// Fixtures are invented and industry-neutral, and none is copied from the prompt.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const createMock = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: createMock }
  },
}))

import { writeAndJudgeOpening } from '../write-opening'
import type { ObservationCandidate } from '../types'

const FINDINGS_TEXT = 'Ashfield Survey Works listed two field roles and runs three regional depots.'

const CANDIDATE: ObservationCandidate = {
  id: 'c1',
  observation: FINDINGS_TEXT,
  source: 'web',
  provenance: 'a public listings page',
  score_total: 6,
  passes_all: false,
} as unknown as ObservationCandidate

/** One Anthropic response carrying a single text block. */
const say = (text: string) => ({
  content: [{ type: 'text', text }],
  usage: { input_tokens: 1, output_tokens: 1 },
})

/** The writer's four blocks, with whatever subject the test wants to try. */
const writerReply = (subject: string) => say([
  'OBSERVATION: Two field roles are open across three depots.',
  'BRIDGE: Capacity lands before the work that pays for it. That order is uncomfortable.',
  'QUESTION: Is closing that gap something you are looking at?',
  `SUBJECT: ${subject}`,
].join('\n'))

const FLOOR_PASS = say('CLAIMS_PRIVATE: NO\nREASON: everything here is visible from outside.')

/** Counts writer calls by the only thing that distinguishes them: the cached system block. */
const writerCalls = () =>
  createMock.mock.calls.filter(([args]) => Array.isArray(args.system)).length

function run(subject: string) {
  return writeAndJudgeOpening({
    buyer: 'Operations Lead',
    apiKey: 'test-key',
    clientName: 'Test Client',
    prospectFirstName: 'Robin',
    candidates: [CANDIDATE],
    p3: 'We keep the work arriving without you chasing it.',
    cta: 'Worth a short conversation?',
    templateOpening: 'The authored opener.',
    // The subject the floor and the judge are handed, recorded for assertion.
    composeEmail1: (opening, question, subj) =>
      `Subject: ${subj ?? 'a note about capacity'}\n\nRobin\n\n${opening}\n\n${question ?? 'Worth a short conversation?'}`,
    prospectId: 'p1',
  })
}

beforeEach(() => {
  createMock.mockReset()
})

describe('a soft subject failure does not increment the attempt count', () => {
  it('makes exactly one writer call when the subject is untraceable and the opening wins', async () => {
    // The written version is labelled A or B at random, so the judge is scripted to pick
    // whichever side is NOT the authored opener rather than a fixed letter.
    createMock.mockImplementation(async (args: { system: unknown; messages: { content: string }[] }) => {
      if (Array.isArray(args.system)) return writerReply('the Harrowgate rollout')
      const content = String(args.messages[0].content)
      if (content.includes('VERSION A')) {
        const a = content.split('VERSION B')[0]
        return say(`CHOICE: ${a.includes('The authored opener.') ? 'B' : 'A'}\nREASON: it reads faster.`)
      }
      return FLOOR_PASS
    })

    const result = await run('the Harrowgate rollout')

    expect(result.written_won).toBe(true)
    // ONE writer call. The subject was rejected and nothing was retried.
    expect(writerCalls()).toBe(1)
    expect(result.retries_used).toBe(0)
    expect(result.retry_used).toBe(false)
    // And the subject was discarded, so the authored one will ship.
    expect(result.subject).toBeNull()
    // The opening itself is untouched by the subject's failure.
    expect(result.opening).toContain('Two field roles are open across three depots.')
  })

  it('keeps the subject when it passes, on the same single attempt', async () => {
    createMock.mockImplementation(async (args: { system: unknown; messages: { content: string }[] }) => {
      if (Array.isArray(args.system)) return writerReply('two field roles, three depots')
      if (String(args.messages[0].content).includes('VERSION A')) {
        const a = String(args.messages[0].content).split('VERSION B')[0]
        return say(`CHOICE: ${a.includes('The authored opener.') ? 'B' : 'A'}\nREASON: it reads faster.`)
      }
      return FLOOR_PASS
    })

    const result = await run('two field roles, three depots')

    expect(result.written_won).toBe(true)
    expect(result.subject).toBe('two field roles, three depots')
    expect(writerCalls()).toBe(1)
    expect(result.retries_used).toBe(0)
  })

  it('hands the generated subject to the floor, so the floor reads the real email', async () => {
    const floorInputs: string[] = []
    createMock.mockImplementation(async (args: { system: unknown; messages: { content: string }[] }) => {
      if (Array.isArray(args.system)) return writerReply('two field roles, three depots')
      const content = String(args.messages[0].content)
      if (content.includes('VERSION A')) {
        const a = content.split('VERSION B')[0]
        return say(`CHOICE: ${a.includes('The authored opener.') ? 'B' : 'A'}\nREASON: it reads faster.`)
      }
      floorInputs.push(content)
      return FLOOR_PASS
    })

    await run('two field roles, three depots')

    expect(floorInputs).toHaveLength(1)
    expect(floorInputs[0]).toContain('Subject: two field roles, three depots')
  })

  it('hands the AUTHORED subject to the floor when the generated one was discarded', async () => {
    const floorInputs: string[] = []
    createMock.mockImplementation(async (args: { system: unknown; messages: { content: string }[] }) => {
      if (Array.isArray(args.system)) return writerReply('the Harrowgate rollout')
      const content = String(args.messages[0].content)
      if (content.includes('VERSION A')) {
        const a = content.split('VERSION B')[0]
        return say(`CHOICE: ${a.includes('The authored opener.') ? 'B' : 'A'}\nREASON: it reads faster.`)
      }
      floorInputs.push(content)
      return FLOOR_PASS
    })

    await run('the Harrowgate rollout')

    expect(floorInputs[0]).toContain('Subject: a note about capacity')
    expect(floorInputs[0]).not.toContain('Harrowgate')
  })
})

describe('a firmographic figure in the subject is discarded, same soft path', () => {
  it('ships the authored subject and does not spend an attempt', async () => {
    const floorInputs: string[] = []
    createMock.mockImplementation(async (args: { system: unknown; messages: { content: string }[] }) => {
      if (Array.isArray(args.system)) return writerReply('turnover past £750K')
      const content = String(args.messages[0].content)
      if (content.includes('VERSION A')) {
        const a = content.split('VERSION B')[0]
        return say(`CHOICE: ${a.includes('The authored opener.') ? 'B' : 'A'}\nREASON: it reads faster.`)
      }
      floorInputs.push(content)
      return FLOOR_PASS
    })

    const result = await run('turnover past £750K')

    // Discarded: composition falls back to the variant's authored subject_line.
    expect(result.subject).toBeNull()
    // Free: one writer call, no retry, and the opening still shipped.
    expect(writerCalls()).toBe(1)
    expect(result.retries_used).toBe(0)
    expect(result.written_won).toBe(true)
    expect(result.opening).toContain('Two field roles are open across three depots.')
    // The floor read the authored subject, never the rejected one.
    expect(floorInputs[0]).toContain('Subject: a note about capacity')
    expect(floorInputs[0]).not.toContain('750K')
  })
})

describe('the judge compares two emails carrying the same subject', () => {
  it('gives neither side a subject advantage, so the comparison stays about the opening', async () => {
    const judgeInputs: string[] = []
    createMock.mockImplementation(async (args: { system: unknown; messages: { content: string }[] }) => {
      if (Array.isArray(args.system)) return writerReply('two field roles, three depots')
      const content = String(args.messages[0].content)
      if (content.includes('VERSION A')) {
        judgeInputs.push(content)
        const a = content.split('VERSION B')[0]
        return say(`CHOICE: ${a.includes('The authored opener.') ? 'B' : 'A'}\nREASON: it reads faster.`)
      }
      return FLOOR_PASS
    })

    await run('two field roles, three depots')

    expect(judgeInputs).toHaveLength(1)
    const subjects = [...judgeInputs[0].matchAll(/^Subject: (.*)$/gm)].map(m => m[1])
    expect(subjects).toHaveLength(2)
    expect(subjects[0]).toBe(subjects[1])
    expect(subjects[0]).toBe('a note about capacity')
  })
})

describe('a template win clears the subject with everything else', () => {
  it('returns a null subject when the written version loses', async () => {
    createMock.mockImplementation(async (args: { system: unknown; messages: { content: string }[] }) => {
      if (Array.isArray(args.system)) return writerReply('two field roles, three depots')
      const content = String(args.messages[0].content)
      if (content.includes('VERSION A')) {
        const a = content.split('VERSION B')[0]
        // Always choose the authored opener: the template wins every round.
        return say(`CHOICE: ${a.includes('The authored opener.') ? 'A' : 'B'}\nREASON: the template reads better.`)
      }
      return FLOOR_PASS
    })

    const result = await run('two field roles, three depots')

    expect(result.written_won).toBe(false)
    expect(result.subject).toBeNull()
    expect(result.opening).toBeNull()
  })
})

// ─── Where the reader is allowed to travel ───────────────────────────────────
//
// STEP 3, THIRD CHECK, AT THE REAL CALL SITE RATHER THAN BY READING IT. The two prompt
// builders can be unit-tested in isolation and still be wired up wrongly: what actually
// decides the cache is which argument of client.messages.create the varying string ends
// up in. This drives the production loop against the scripted model and inspects the
// requests it really sent.
//
// It is the same shape as the fake-that-does-not-honour-a-filter problem recorded in
// CLAUDE.md, one level up: a unit test on buildWriterAssignment passes identically whether
// the assignment is prepended to the user message or concatenated onto the system prompt.
describe('the reader travels in the user message, never in the cached prefix', () => {
  const BUYER = 'Operations Lead'

  /** Every request whose system block is the cached array, i.e. every writer call. */
  const writerRequests = () =>
    createMock.mock.calls
      .map(([args]) => args as { system: unknown; messages: { content: string }[] })
      .filter(a => Array.isArray(a.system))

  beforeEach(() => {
    createMock.mockImplementation(async (args: { system: unknown; messages: { content: string }[] }) => {
      if (Array.isArray(args.system)) return writerReply('two field roles, three depots')
      const content = String(args.messages[0].content)
      if (content.includes('VERSION A')) {
        const a = content.split('VERSION B')[0]
        return say(`CHOICE: ${a.includes('The authored opener.') ? 'B' : 'A'}\nREASON: it reads faster.`)
      }
      return FLOOR_PASS
    })
  })

  it('sends the buyer in the writer user message and not in the cached system block', async () => {
    await run('two field roles, three depots')

    const writer = writerRequests()
    expect(writer.length).toBeGreaterThan(0)

    for (const req of writer) {
      const system = (req.system as { text: string; cache_control?: unknown }[])[0]
      // Still marked as a cache breakpoint after the change.
      expect(system.cache_control).toEqual({ type: 'ephemeral' })
      // The varying value is NOT in the cached prefix.
      expect(system.text).not.toContain(BUYER)
      expect(system.text).not.toContain('Test Client')
      // And it IS in the per-call user message, where varying is free.
      expect(String(req.messages[0].content)).toContain(`Who you are writing to: ${BUYER}`)
    }
  })

  it('the judge is handed the buyer, uncached, on the same run', async () => {
    await run('two field roles, three depots')

    // The judge and the floor judge are the calls with a plain string system prompt. The
    // judge is the one whose user message holds both labelled versions.
    const judge = createMock.mock.calls
      .map(([args]) => args as { system: unknown; messages: { content: string }[] })
      .find(a => !Array.isArray(a.system) && String(a.messages[0].content).includes('VERSION A'))

    expect(judge, 'no judge call was made').toBeDefined()
    // A PLAIN STRING, deliberately: ~124 tokens is far below the minimum cacheable prefix,
    // so a breakpoint here would be ignored while spending one of the four allowed.
    expect(typeof judge!.system).toBe('string')
    expect(judge!.system as string).toContain(`Who is reading it: ${BUYER}`)
  })
})
