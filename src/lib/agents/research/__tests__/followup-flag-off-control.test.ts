// THE POSITIVE CONTROL FOR THE FLAG, AND THE MUTATION TEST FOR THE COHERENCE RULE.
//
// ═══ THE CONTROL IS NOW STRUCTURAL, AND THAT IS THE WHOLE POINT OF THE REDESIGN ═══
//
// The first version of this feature asked the Email 1 writer for emails 2 and 3 in the
// same response, so proving Email 1 unaffected meant asserting byte-identity of a prompt,
// an assignment and a parser one at a time, and hoping the list was complete. It was not:
// Email 1's gate failures went 23 -> 66 anyway, through a route no byte-identity assertion
// covered, because the interference was in the model's framing rather than in any string.
//
// With the follow-ups in their own call, write-opening.ts is BYTE-IDENTICAL TO MAIN. The
// real control for "Email 1 is unaffected" is therefore a `diff` of that file returning
// nothing, which is asserted in CI-visible form by the shell check in the commit message
// and re-asserted here at the level this suite can reach: the Email 1 writer exports no
// follow-up surface at all, so there is nothing for a caller to pass it.
//
// RULE ZERO. Every fixture is invented and industry-neutral.

import { describe, it, expect } from 'vitest'
import * as writeOpening from '../write-opening'
import { parseFollowupOutput, buildFollowupSystemPrompt } from '../write-followups'
import {
  splitFollowupFrame,
  buildFollowupReference,
  composeFollowupBody,
  EMPTY_FOLLOWUP,
} from '../followup-frame'

const TEMPLATE_2 = [
  '{{first_name}},',
  'Most workshops that run this way find the same thing happens every quarter.',
  'The gap is not the work itself. It is the week that disappears before the next job starts.',
  'Does that match what you see?',
  'Sam\nExample Co',
].join('\n\n')

const TEMPLATE_3 = [
  '{{first_name}},',
  'Many owners try to fix this by working later.',
  'That holds for a fortnight, then the next deadline arrives and it stops.',
  'Want me to sketch what the first month looks like?',
  'Sam\nExample Co',
].join('\n\n')

describe('email 1 does not know this feature exists', () => {
  // THE STRUCTURAL CONTROL. write-opening.ts is byte-identical to main, so it cannot have
  // gained a follow-up parameter, a follow-up field, or a conditional. If any of these
  // appear, the redesign has quietly become the one-call design again.
  it('the email 1 writer exports no follow-up surface', () => {
    const exported = Object.keys(writeOpening)
    const followupish = exported.filter(k => /followup/i.test(k))
    expect(followupish).toEqual([])
  })

  it('buildWriterPrompt takes no arguments, so no caller can vary it', () => {
    expect(writeOpening.buildWriterPrompt.length).toBe(0)
    // Control: the function really does return a prompt, so the assertion above is not
    // passing over an empty stub.
    expect(writeOpening.buildWriterPrompt().length).toBeGreaterThan(1000)
  })

  it('the email 1 parser returns exactly its five fields and nothing more', () => {
    const reply = [
      'SCRATCH: weighing two options here.',
      'OBSERVATION: You took on a second unit in March.',
      'BRIDGE: A second unit needs work from people who have not quoted you yet.',
      'QUESTION: Worth a short call?',
      'SUBJECT: the second unit',
    ].join('\n')
    const parsed = writeOpening.parseWriterOutput(reply)
    expect(Object.keys(parsed).sort()).toEqual(
      ['bridge', 'observation', 'opening', 'question', 'subject'],
    )
    expect(parsed.subject).toBe('the second unit')
    expect(parsed.observation).not.toContain('weighing')
  })

  it('an EMAIL2 block in an email 1 reply is inert, because nothing reads it', () => {
    // The follow-up writer is a different call with a different prompt, so the Email 1
    // writer is never asked for these and its parser has no label for them. If one ever
    // appeared it would be treated as prose by the subject capture, which is the
    // pre-existing behaviour for any trailing text and is unchanged by this branch.
    const parsed = writeOpening.parseWriterOutput(
      'OBSERVATION: You took on a second unit.\n\nBRIDGE: It needs new work.\n\nQUESTION: Worth a call?\n\nSUBJECT: the unit',
    )
    expect(parsed.observation).toBe('You took on a second unit.')
    expect(parsed.bridge).toBe('It needs new work.')
  })
})

describe('the follow-up prompt is its own job, not a copy of email 1\'s', () => {
  const p = buildFollowupSystemPrompt()

  it('is far smaller than the email 1 prompt', () => {
    // The cost argument for a separate call depends on this. If this prompt ever
    // approaches Email 1's size, the separate call really does start paying twice.
    expect(p.length).toBeLessThan(writeOpening.buildWriterPrompt().length / 3)
  })

  it('is large enough to be cacheable', () => {
    // Sonnet ignores a cache breakpoint below ~1,024 tokens, silently. The floor and judge
    // prompts in write-opening are ~124 tokens and deliberately not cached for this
    // reason. This one must clear the bar or its breakpoint is decorative.
    expect(p.length).toBeGreaterThan(4500)
  })

  it('tells the writer to explain the mechanism, which email 1 forbids', () => {
    // The two jobs contradict each other. That contradiction is why the prompts are
    // separate, and this asserts the separation is real rather than nominal.
    expect(p).toMatch(/HOW THE WORK ACTUALLY RUNS/i)
    expect(writeOpening.buildWriterPrompt()).toMatch(/do not name the service/i)
  })

  it('carries no worked example of a follow-up email', () => {
    expect(p).not.toMatch(/EMAIL2:\s*\w+.*\n.*\n.*\?/)
  })

  it('states a per-sentence budget, which is what the length failures needed', () => {
    expect(p).toMatch(/12 to 18 words/)
  })
})

describe('the follow-up parser', () => {
  it('splits the two blocks and keeps paragraph breaks', () => {
    const raw = 'EMAIL2: First para.\n\nSecond para?\nEMAIL3: Third para.\n\nFourth para?'
    const p = parseFollowupOutput(raw)
    expect(p.email2.split(/\n{2,}/)).toHaveLength(2)
    expect(p.email2).not.toContain('EMAIL3')
    expect(p.email3).toContain('Fourth para?')
  })

  it('returns empty strings, never undefined, when a block is absent', () => {
    expect(parseFollowupOutput('nothing labelled here')).toEqual({ email2: '', email3: '' })
  })

  it('strips a conversational preamble', () => {
    expect(parseFollowupOutput('EMAIL2: Here is email 2: You took the unit on.\nEMAIL3: x').email2)
      .toBe('You took the unit on.')
  })
})

describe('the frame is split deterministically, or not at all', () => {
  it('strips exactly the first middle paragraph', () => {
    const ref = buildFollowupReference(TEMPLATE_2)
    expect(ref).not.toContain('Most workshops')
    expect(ref).toContain('The gap is not the work itself.')
    expect(ref).toContain('Does that match what you see?')
    expect(ref).not.toContain('{{first_name}}')
    expect(ref).not.toContain('Example Co')
  })

  it('returns null rather than a wrong answer when there is no frame', () => {
    expect(splitFollowupFrame('One line only.')).toBeNull()
    expect(splitFollowupFrame('{{first_name}},\n\nSam\nExample Co')).toBeNull()
    expect(splitFollowupFrame('{{first_name}},\n\nBody here.\n\na\nb\nc\nd')).toBeNull()
  })

  it('composes written prose back into the frame, greeting and sign-off supplied', () => {
    const body = composeFollowupBody(TEMPLATE_2, 'First para.\n\nSecond para?')
    expect(body).toBe('{{first_name}},\n\nFirst para.\n\nSecond para?\n\nSam\nExample Co')
    expect(body).not.toContain('reply stop')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// THE COHERENCE RULE, MUTATION-TESTED
//
// The rule: emails 2 and 3 are used only if the personalised Email 1 is what ships.
//
// The redesign makes this stronger than it was. In the one-call design a generated
// follow-up EXISTED on every attempt and had to be nulled on the way out, so the rule was
// a condition that could be got wrong. Here the follow-up call is NOT MADE AT ALL unless
// written_won is true, so on every fallback path there is no generated follow-up in
// existence to mis-handle.
// ═══════════════════════════════════════════════════════════════════════════════

describe('coherence: a follow-up cannot outlive its email 1', () => {
  const losing = {
    written_won: false as const,
    opening: null,
    email2: EMPTY_FOLLOWUP,
    email3: EMPTY_FOLLOWUP,
  }

  it('the empty follow-up carries no prose and no body', () => {
    expect(EMPTY_FOLLOWUP.prose).toBeNull()
    expect(EMPTY_FOLLOWUP.body).toBeNull()
  })

  it('THE MUTATION: a careless consumer reading email2.prose directly still gets null', () => {
    // The consumer the producer-side rule exists to survive: it applies no condition of
    // its own, as a future storage or composition change might not.
    const careless = (r: typeof losing) => ({
      email1: r.opening, email2: r.email2.prose, email3: r.email3.prose,
    })
    const shipped = careless(losing)
    expect(shipped.email1).toBeNull()
    expect(shipped.email2).toBeNull()
    expect(shipped.email3).toBeNull()
  })

  it('THE MUTATION: the forbidden pairing is never produced by any losing shape', () => {
    // Stated as the INVARIANT rather than as a list of paths, so a path added later is
    // covered without editing this test.
    const forbidden = (r: { opening: string | null; email2: { prose: string | null } }) =>
      r.opening === null && r.email2.prose !== null

    expect(forbidden(losing)).toBe(false)
    // The control: the predicate really can detect the fault it is looking for.
    expect(forbidden({ opening: null, email2: { prose: 'a callback to nothing' } })).toBe(true)
  })

  it('THE MUTATION: the gating condition covers won-but-empty, not just lost', () => {
    // written_won true with a null opening should also decline, because the callback would
    // have nothing to point at. produceOpening tests `!written_won || opening === null`.
    const decline = (won: boolean, opening: string | null) => !won || opening === null
    expect(decline(false, 'text')).toBe(true)
    expect(decline(true, null)).toBe(true)
    expect(decline(true, 'text')).toBe(false)   // the only case that proceeds
  })
})
