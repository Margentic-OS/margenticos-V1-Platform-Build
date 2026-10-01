// A FAULT OF FORM IS REPAIRED, NOT FAILED. EXPERIMENT, 2026-10-01.
//
// DRIVES THE REAL writeAndJudgeOpening against a scripted model, the same way
// write-opening-factcheck-loop.test.ts does, so nothing about the decision is restated here.
//
// WHAT HAS TO BE TRUE, and each is a test below:
//   a draft whose only fault is a day in a date goes back as a REPAIR, not as a new attempt
//   so does a sentence over the cap
//   the attempt is not spent: the prospect still has its full budget afterwards
//   a draft with a fault of content beside it is NOT repaired
//   a repaired draft is held to every gate, so a repair cannot pass what a gate rejects
//   repairs are capped, so a rule the writer cannot satisfy does not loop
//
// RULE ZERO. Every fixture is invented and industry-neutral.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const createMock = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: createMock }
  },
}))

import {
  writeAndJudgeOpening, isMechanicalOnly, buildRepairInstruction,
  MAX_REPAIRS_PER_ATTEMPT, MECHANICAL_MARKERS,
  SENTENCE_CAP_MARKER, OBSERVATION_CAP_MARKER, WRITER_MAX_SENTENCE_WORDS,
  type AttemptObservation,
} from '../write-opening'
import {
  findDateGranularityFaults, dateGranularityFeedback,
  DATE_DAY_MARKER, DATE_CURRENT_YEAR_MARKER,
} from '@/lib/style/date-granularity'
import { splitIntoSentences } from '@/lib/style/sentence-count'
import type { ObservationCandidate } from '../types'

const CANDIDATE: ObservationCandidate = {
  id: 'c1',
  observation: 'Two locations were added on 4 March and four roles listed in the same month.',
  source: 'web',
  provenance: 'a public listings page',
  score_total: 6,
  passes_all: false,
} as unknown as ObservationCandidate

const OBS_WITH_DAY = 'Two locations were added on 4 March.'
const OBS_FIXED = 'Two locations were added in March.'
const BRIDGE = 'The filling of them lands before the work that pays for it.'
// Twenty words, two over the cap, and nothing else wrong with it.
const BRIDGE_LONG = 'The filling of every one of them lands a long way before the work that pays for it all arrives.'
const QUESTION = 'Is closing that gap something you are looking at?'
const TEMPLATE_OPENING = 'The authored opener.'
const REPAIR_HEADING = '## Repair this draft'
const REWRITE_HEADING = '## Your previous attempt did not ship'

const say = (text: string) => ({
  content: [{ type: 'text', text }],
  usage: { input_tokens: 1, output_tokens: 1 },
})

const blocks = (observation: string, bridge: string, question = QUESTION) => say([
  `OBSERVATION: ${observation}`,
  `BRIDGE: ${bridge}`,
  `QUESTION: ${question}`,
  'SUBJECT: two locations, four roles',
].join('\n'))

const FLOOR_PASS = say('CLAIMS_PRIVATE: NO\nREASON: everything here is visible from outside.')

/**
 * The writer is the only call with an array system block. `writer` decides what it says,
 * given the user message and how many writer calls came before it.
 */
function script(writer: (user: string, nth: number) => ReturnType<typeof say>) {
  let n = 0
  createMock.mockImplementation(async (args: { system: unknown; messages: { content: string }[] }) => {
    const content = String(args.messages[0].content)
    if (Array.isArray(args.system)) return writer(content, n++)
    if (!content.includes('VERSION A')) return FLOOR_PASS
    const writtenIsA = !content.split('VERSION B')[0].includes(TEMPLATE_OPENING)
    return say(`CHOICE: ${writtenIsA ? 'A' : 'B'}\nREASON: it reads faster.`)
  })
}

const writerPrompts = () =>
  createMock.mock.calls
    .filter(([a]) => Array.isArray(a.system))
    .map(([a]) => String(a.messages[0].content))

function run(onAttempt?: (o: AttemptObservation) => void) {
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
    onAttempt,
  })
}

beforeEach(() => {
  createMock.mockReset()
  vi.spyOn(Math, 'random').mockReturnValue(0.1)
})
afterEach(() => vi.restoreAllMocks())

describe('a fault of form goes back as a repair and does not spend the attempt', () => {
  it('CONTROL: a clean draft ships with no repair, so the repairs below mean something', async () => {
    script(() => blocks(OBS_FIXED, BRIDGE))
    const attempts: AttemptObservation[] = []
    const r = await run(o => attempts.push(o))
    expect(r.written_won).toBe(true)
    expect(writerPrompts()).toHaveLength(1)
    expect(attempts[0].repairs).toBe(0)
    expect(attempts[0].repaired_faults).toEqual([])
  })

  it('repairs a day in a date, and the repair is a different message from a rewrite', async () => {
    script((user) => user.includes(REPAIR_HEADING) ? blocks(OBS_FIXED, BRIDGE) : blocks(OBS_WITH_DAY, BRIDGE))
    const attempts: AttemptObservation[] = []
    const r = await run(o => attempts.push(o))

    expect(r.written_won).toBe(true)
    expect(r.observation).toBe(OBS_FIXED)
    // THE ATTEMPT WAS NOT SPENT. One attempt, no retry, although the writer was called twice.
    expect(attempts).toHaveLength(1)
    expect(r.retries_used).toBe(0)

    const prompts = writerPrompts()
    expect(prompts).toHaveLength(2)
    // The repair carries the draft, the fault and the instruction to touch nothing else.
    expect(prompts[1]).toContain(REPAIR_HEADING)
    expect(prompts[1]).toContain(OBS_WITH_DAY)
    expect(prompts[1]).toContain(BRIDGE)
    expect(prompts[1]).toContain(DATE_DAY_MARKER)
    expect(prompts[1]).toContain('Fix that and nothing else')
    // And it is NOT the free rewrite, which invites a different version.
    expect(prompts[1]).not.toContain(REWRITE_HEADING)
    expect(prompts[1]).not.toContain('Write a different version')
  })

  it('records what was repaired, because a repaired fault is in no failure list', async () => {
    script((user) => user.includes(REPAIR_HEADING) ? blocks(OBS_FIXED, BRIDGE) : blocks(OBS_WITH_DAY, BRIDGE))
    const attempts: AttemptObservation[] = []
    await run(o => attempts.push(o))
    expect(attempts[0].kind).toBe('compared')
    expect(attempts[0].gate_failures).toEqual([])
    expect(attempts[0].repairs).toBe(1)
    expect(attempts[0].repaired_faults).toHaveLength(1)
    expect(attempts[0].repaired_faults![0]).toContain(DATE_DAY_MARKER)
  })

  it('repairs a sentence over the cap the same way', async () => {
    script((user) => user.includes(REPAIR_HEADING) ? blocks(OBS_FIXED, BRIDGE) : blocks(OBS_FIXED, BRIDGE_LONG))
    const attempts: AttemptObservation[] = []
    const r = await run(o => attempts.push(o))
    expect(r.written_won).toBe(true)
    expect(r.bridge).toBe(BRIDGE)
    expect(attempts).toHaveLength(1)
    expect(attempts[0].repaired_faults![0]).toContain(SENTENCE_CAP_MARKER)
    expect(writerPrompts()[1]).toContain(BRIDGE_LONG)
  })

  it('repairs twice when the first fix exposes the second fault', async () => {
    // A day in the date and nothing else, then a long sentence and nothing else, then clean.
    script((_user, nth) =>
      nth === 0 ? blocks(OBS_WITH_DAY, BRIDGE) : nth === 1 ? blocks(OBS_FIXED, BRIDGE_LONG) : blocks(OBS_FIXED, BRIDGE))
    const attempts: AttemptObservation[] = []
    const r = await run(o => attempts.push(o))
    expect(r.written_won).toBe(true)
    expect(attempts).toHaveLength(1)
    expect(attempts[0].repairs).toBe(2)
    expect(writerPrompts().filter(p => p.includes(REPAIR_HEADING))).toHaveLength(2)
  })
})

describe('what a repair must not do', () => {
  it('does NOT repair a draft that also has a fault of content', async () => {
    // A day in the date AND the prospect named in the observation. The second is content.
    const named = 'Robin added two locations on 4 March.'
    script((user) => user.includes(REWRITE_HEADING) ? blocks(OBS_FIXED, BRIDGE) : blocks(named, BRIDGE))
    const attempts: AttemptObservation[] = []
    const r = await run(o => attempts.push(o))

    const prompts = writerPrompts()
    // No repair message was ever sent. The second writer call is the ordinary rewrite.
    expect(prompts.some(p => p.includes(REPAIR_HEADING))).toBe(false)
    expect(prompts[1]).toContain(REWRITE_HEADING)
    expect(attempts[0].kind).toBe('gated')
    expect(attempts[0].repairs).toBe(0)
    // Both faults are quoted to the rewrite, the mechanical one included.
    expect(attempts[0].gate_failures.join(' ')).toContain(DATE_DAY_MARKER)
    expect(attempts[0].gate_failures.join(' ')).toContain('names the prospect')
    expect(r.written_won).toBe(true)
    expect(r.retries_used).toBe(1)
  })

  it('holds a repaired draft to every gate: a repair that adds a content fault fails the attempt', async () => {
    // The repair fixes the date and names the prospect while it is there.
    const worse = 'Robin added two locations in March.'
    script((user) =>
      user.includes(REPAIR_HEADING) ? blocks(worse, BRIDGE)
      : user.includes(REWRITE_HEADING) ? blocks(OBS_FIXED, BRIDGE)
      : blocks(OBS_WITH_DAY, BRIDGE))
    const attempts: AttemptObservation[] = []
    const r = await run(o => attempts.push(o))

    expect(attempts[0].kind).toBe('gated')
    expect(attempts[0].gate_failures.join(' ')).toContain('names the prospect')
    // The repaired text never shipped. The next attempt is a rewrite and that is what won.
    expect(r.observation).toBe(OBS_FIXED)
    expect(r.retries_used).toBe(1)
  })

  it('is CAPPED: a writer that cannot fix the date is failed as before, and does not loop', async () => {
    script(() => blocks(OBS_WITH_DAY, BRIDGE))
    const attempts: AttemptObservation[] = []
    const r = await run(o => attempts.push(o))

    expect(r.written_won).toBe(false)
    // Weak material buys two attempts. Each is one write plus the capped repairs, no more.
    expect(attempts).toHaveLength(2)
    expect(attempts.every(a => a.repairs === MAX_REPAIRS_PER_ATTEMPT)).toBe(true)
    expect(writerPrompts()).toHaveLength(2 * (1 + MAX_REPAIRS_PER_ATTEMPT))
    expect(r.gate_failures.join(' ')).toContain(DATE_DAY_MARKER)
    expect(r.judge_reasoning).toContain('Failed deterministic gates on the final attempt')
  })
})

describe('which faults count as faults of form', () => {
  const lengthFault =
    `the bridge has a sentence of 20 words, ${SENTENCE_CAP_MARKER} ${WRITER_MAX_SENTENCE_WORDS}: shorten it.`
  const observationCapFault = `the observation is 27 words, ${OBSERVATION_CAP_MARKER} 24: cut a fact`
  const dayFault = `"4 March" ${DATE_DAY_MARKER}: "Two locations were added on 4 March.".`
  const yearFault = `"March 2026" ${DATE_CURRENT_YEAR_MARKER}: "Two locations were added in March 2026.".`

  it.each([lengthFault, observationCapFault, dayFault, yearFault])('repairs: %s', fault => {
    expect(isMechanicalOnly([fault])).toBe(true)
  })

  it('repairs a date fault and a length fault together', () => {
    expect(isMechanicalOnly([dayFault, lengthFault])).toBe(true)
  })

  it.each([
    'opening names the prospect ("Robin"), which reads as third person',
    'claims not traceable to any finding: Harbour',
    'the bridge names what they lack. Notice something that IS there instead: "with no client"',
    'the observation describes an event from 2025 but never says 2025',
    'writer returned no bridge',
  ])('does NOT repair a fault of content: %s', fault => {
    expect(isMechanicalOnly([fault])).toBe(false)
    // And one fault of content beside a fault of form is still not a repair.
    expect(isMechanicalOnly([dayFault, fault])).toBe(false)
  })

  it('does NOT repair an empty list, which is every()-over-nothing', () => {
    expect(isMechanicalOnly([])).toBe(false)
  })

  it('the date markers really are in the messages the gate emits, not just in this test', () => {
    // A control on the control. If the date feedback were reworded without the constants,
    // isMechanicalOnly would quietly stop matching and no draft would ever be repaired.
    const day = findDateGranularityFaults('Two locations were added on 4 March.', new Date('2026-10-01T00:00:00Z'), splitIntoSentences)
    expect(day).toHaveLength(1)
    expect(dateGranularityFeedback(day[0])).toContain(DATE_DAY_MARKER)
    const year = findDateGranularityFaults('Two locations were added in March 2026.', new Date('2026-10-01T00:00:00Z'), splitIntoSentences)
    expect(year).toHaveLength(1)
    expect(dateGranularityFeedback(year[0])).toContain(DATE_CURRENT_YEAR_MARKER)
  })

  it('the set is the four markers and nothing else', () => {
    expect([...MECHANICAL_MARKERS].sort()).toEqual(
      [SENTENCE_CAP_MARKER, OBSERVATION_CAP_MARKER, DATE_DAY_MARKER, DATE_CURRENT_YEAR_MARKER].sort(),
    )
  })
})

describe('the repair message', () => {
  it('shows the whole draft and every fault, and forbids restating the event', () => {
    const text = buildRepairInstruction(
      { observation: OBS_WITH_DAY, bridge: BRIDGE, question: QUESTION, subject: 'two locations' },
      ['fault one', 'fault two'],
    )
    expect(text).toContain(`OBSERVATION: ${OBS_WITH_DAY}`)
    expect(text).toContain(`BRIDGE: ${BRIDGE}`)
    expect(text).toContain(`QUESTION: ${QUESTION}`)
    expect(text).toContain('SUBJECT: two locations')
    expect(text).toContain('- fault one')
    expect(text).toContain('- fault two')
    expect(text).toContain('do not restate the event in different')
  })
})
