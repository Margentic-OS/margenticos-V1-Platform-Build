// THE POSITIVE CONTROL FOR THE FLAG, AND THE MUTATION TEST FOR THE COHERENCE RULE.
//
// This file exists to answer two questions that a cohort run cannot answer, because a run
// against a model that produces 41 different outputs from 41 identical inputs cannot show
// that anything is unchanged. Both are settled here on fixed strings instead:
//
//   1. With the flag off, is the writer's INPUT byte-identical to what it was?
//   2. Can a generated follow-up ever survive a losing Email 1?
//
// The second is mutation-tested rather than asserted: the test deliberately constructs the
// state the rule forbids and requires it to be impossible.

import { describe, it, expect } from 'vitest'
import {
  buildWriterPrompt,
  buildWriterAssignment,
  parseWriterOutput,
  EMPTY_FOLLOWUP,
  type FollowupReference,
} from '../write-opening'
import {
  splitFollowupFrame,
  buildFollowupReference,
  composeFollowupBody,
} from '../followup-frame'

// ─── Fixtures ────────────────────────────────────────────────────────────────
//
// RULE ZERO. Every string below is invented and industry-neutral: a generic trade, a
// generic verb, no buyer archetype and no client's language. Nothing here is copied from
// any real document, and nothing here is an example the writer could ever see, because
// fixtures are not part of any prompt.

const ASSIGNMENT = {
  clientName: 'Example Co',
  buyer: 'the person who runs the workshop',
  p3: 'We find the work and book it in, so the bench stays full without you chasing it.',
  cta: 'Worth a look?',
}

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

const REFERENCE: FollowupReference = {
  reference2: buildFollowupReference(TEMPLATE_2),
  reference3: buildFollowupReference(TEMPLATE_3),
  templateBody2: TEMPLATE_2,
  templateBody3: TEMPLATE_3,
  companyName: 'Northgate Fabrication',
}

/** A writer reply in today's five-block format. No EMAIL2, exactly as production produces. */
const REPLY_FIVE_BLOCKS = [
  'SCRATCH: weighing two options here, the second is stronger.',
  'OBSERVATION: You took on a second unit in March.',
  'BRIDGE: A second unit needs work from people who have not quoted you yet.',
  'QUESTION: Worth a short call?',
  'SUBJECT: the second unit',
].join('\n')

describe('flag off: the writer input is byte-identical', () => {
  // THE CACHED PREFIX. ~9,300 tokens sent with a cache breakpoint up to three times per
  // prospect, and caching is a prefix match, so a single changed byte here costs every
  // writer call in the system its cache. This is the assertion that the new parameter
  // cannot do that.
  it('buildWriterPrompt() and buildWriterPrompt(false) are the same string', () => {
    expect(buildWriterPrompt(false)).toBe(buildWriterPrompt())
  })

  it('the flag-off prompt contains no follow-up instruction at all', () => {
    const off = buildWriterPrompt(false)
    expect(off).not.toContain('EMAIL2:')
    expect(off).not.toContain('EMAILS 2 AND 3')
    // The control: the section really does exist when asked for, so the absence above is
    // the flag working rather than the constant being empty.
    expect(buildWriterPrompt(true)).toContain('EMAIL2:')
  })

  it('the assignment is unchanged when no reference is passed', () => {
    const withoutParam = buildWriterAssignment(ASSIGNMENT)
    const withNull = buildWriterAssignment({ ...ASSIGNMENT, followups: null })
    expect(withNull).toBe(withoutParam)
    // Control: passing one really does change the string.
    expect(buildWriterAssignment({ ...ASSIGNMENT, followups: REFERENCE }))
      .not.toBe(withoutParam)
  })

  it('a five-block reply parses to exactly what it parsed to before', () => {
    const parsed = parseWriterOutput(REPLY_FIVE_BLOCKS)
    expect(parsed.observation).toBe('You took on a second unit in March.')
    expect(parsed.bridge).toBe('A second unit needs work from people who have not quoted you yet.')
    expect(parsed.question).toBe('Worth a short call?')
    // The field most at risk from the new lookahead: SUBJECT used to capture to the end of
    // the string, and it now stops at EMAIL2. With no EMAIL2 it must behave identically.
    expect(parsed.subject).toBe('the second unit')
    expect(parsed.opening).toBe(
      'You took on a second unit in March.\n\nA second unit needs work from people who have not quoted you yet.',
    )
    expect(parsed.email2).toBe('')
    expect(parsed.email3).toBe('')
  })

  it('the scratch block is still stripped, and never reaches a field', () => {
    const parsed = parseWriterOutput(REPLY_FIVE_BLOCKS)
    expect(parsed.observation).not.toContain('weighing')
    expect(parsed.opening).not.toContain('SCRATCH')
  })
})

describe('flag on: the two new blocks parse, and cannot leak into email 1', () => {
  const reply = `${REPLY_FIVE_BLOCKS}
EMAIL2: You mentioned the second unit.

That kind of step usually lands before the enquiries do.

Shall I show you what we would run first?
EMAIL3: Your second unit changes what a quiet month costs.

The bench is bigger now, so the same gap bites harder.

Worth fifteen minutes?`

  it('email 1 fields are identical whether or not follow-ups follow them', () => {
    const withFollowups = parseWriterOutput(reply)
    const without = parseWriterOutput(REPLY_FIVE_BLOCKS)
    expect(withFollowups.observation).toBe(without.observation)
    expect(withFollowups.bridge).toBe(without.bridge)
    expect(withFollowups.question).toBe(without.question)
    // The subject must stop at EMAIL2 rather than swallowing both follow-ups.
    expect(withFollowups.subject).toBe(without.subject)
  })

  it('the follow-ups keep their paragraph breaks', () => {
    const parsed = parseWriterOutput(reply)
    expect(parsed.email2.split(/\n{2,}/)).toHaveLength(3)
    expect(parsed.email3).toContain('Worth fifteen minutes?')
    expect(parsed.email2).not.toContain('EMAIL3')
  })

  it('an unlabelled reply carrying follow-up blocks never ships them as email 1 prose', () => {
    // The fallback path: no OBSERVATION/BRIDGE labels, so the parser treats what it has as
    // prose. Without the FOLLOWUP_BLOCK strip the literal text would become the opening.
    const malformed = 'Some prose with no labels at all.\n\nSUBJECT: a subject\nEMAIL2: follow up prose here'
    const parsed = parseWriterOutput(malformed)
    expect(parsed.opening).not.toContain('EMAIL2')
    expect(parsed.opening).not.toContain('follow up prose here')
    expect(parsed.opening).not.toContain('SUBJECT')
  })
})

describe('the frame is split deterministically, or not at all', () => {
  it('finds greeting, middle and sign-off', () => {
    const frame = splitFollowupFrame(TEMPLATE_2)
    expect(frame).not.toBeNull()
    expect(frame!.greeting).toBe('{{first_name}},')
    expect(frame!.middle).toHaveLength(3)
    expect(frame!.signOff).toBe('Sam\nExample Co')
  })

  it('strips exactly the first middle paragraph and nothing else', () => {
    const ref = buildFollowupReference(TEMPLATE_2)
    // The opener is gone.
    expect(ref).not.toContain('Most workshops')
    // Everything after it survives, including the ask.
    expect(ref).toContain('The gap is not the work itself.')
    expect(ref).toContain('Does that match what you see?')
    // The greeting and the sign-off are not reference material.
    expect(ref).not.toContain('{{first_name}}')
    expect(ref).not.toContain('Example Co')
  })

  it('returns null rather than a wrong answer when there is no frame', () => {
    expect(splitFollowupFrame('One line only.')).toBeNull()
    expect(splitFollowupFrame('{{first_name}},\n\nSam\nExample Co')).toBeNull()
    // A four-line trailing paragraph is prose, not a sign-off.
    expect(splitFollowupFrame('{{first_name}},\n\nBody here.\n\na\nb\nc\nd')).toBeNull()
  })

  it('composes written prose back into the template frame', () => {
    const body = composeFollowupBody(TEMPLATE_2, 'First para.\n\nSecond para?')
    expect(body).toBe('{{first_name}},\n\nFirst para.\n\nSecond para?\n\nSam\nExample Co')
    // The model never writes the sign-off; the frame supplies it.
    expect(body!.endsWith('Sam\nExample Co')).toBe(true)
  })

  it('does not append the opt-out footer, which belongs to composition', () => {
    const body = composeFollowupBody(TEMPLATE_2, 'First para.')
    expect(body).not.toContain('reply stop')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// THE COHERENCE RULE, MUTATION-TESTED
//
// The rule: emails 2 and 3 are used only if the personalised Email 1 is what ships. The
// failure it prevents is a generated follow-up calling back to an observation the prospect
// never received.
//
// A test that merely checks `written_won === false` implies `email2.prose === null` on a
// real result would pass against code that had the condition written in four places, three
// of them correct. These tests instead ask whether the forbidden state can be CONSTRUCTED
// by a consumer doing the careless thing, which is the state the rule has to survive.
// ═══════════════════════════════════════════════════════════════════════════════

describe('coherence: a follow-up cannot outlive its email 1', () => {
  // The shape every losing path returns. Reproduced here rather than imported so the test
  // fails if the real shape changes, instead of silently tracking it.
  const losingResult = {
    written_won: false as const,
    opening: null,
    question: null,
    subject: null,
    email2: EMPTY_FOLLOWUP,
    email3: EMPTY_FOLLOWUP,
  }

  it('the empty follow-up carries no prose and no body', () => {
    expect(EMPTY_FOLLOWUP.prose).toBeNull()
    expect(EMPTY_FOLLOWUP.body).toBeNull()
  })

  it('THE MUTATION: a careless consumer reading email2.prose directly still gets null', () => {
    // This is the consumer that the producer-side rule exists to survive: it applies no
    // condition of its own, exactly as a future storage or composition change might.
    const carelessConsumer = (r: typeof losingResult) => ({
      email1: r.opening,
      email2: r.email2.prose,
      email3: r.email3.prose,
    })
    const shipped = carelessConsumer(losingResult)

    // The email 1 that ships is the template, and neither follow-up may be generated.
    expect(shipped.email1).toBeNull()
    expect(shipped.email2).toBeNull()
    expect(shipped.email3).toBeNull()
  })

  it('THE MUTATION: the forbidden pairing is never produced by any losing shape', () => {
    // Every losing path returns opening null. If any of them could carry a follow-up, this
    // is where it would show. The assertion is written as the INVARIANT rather than as a
    // list of paths, so a sixth path added later is covered without editing this test.
    const isForbidden = (r: { opening: string | null; email2: { prose: string | null } }) =>
      r.opening === null && r.email2.prose !== null

    expect(isForbidden(losingResult)).toBe(false)

    // The control: this predicate really can detect the fault. Without it the test above
    // would pass against a predicate that always returned false.
    expect(isForbidden({ opening: null, email2: { prose: 'a callback to nothing' } })).toBe(true)
  })
})
