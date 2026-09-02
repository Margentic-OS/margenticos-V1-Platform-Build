// The four writer rules added 2026-09-01, from a human read of 20 shipped emails.
//
// EACH RULE GETS A TEST THAT GOES RED WHEN THAT RULE ALONE IS REVERTED. That is the whole
// design brief for this file: a single test asserting "the prompt is long" would pass with
// any three of the four removed, which is the shape that lets a rule quietly disappear.
//
// The prompt assertions match on the RULE'S OWN LOAD-BEARING CLAUSE rather than on its
// heading. A heading can survive while the instruction under it is gutted, and matching the
// heading would report success in exactly that case.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { logger } from '@/lib/logger'
import { buildWriterPrompt, checkOpeningGates } from '../write-opening'
import {
  findOpeningReferences,
  checkOpeningReferences,
  OPENING_REFERENCE_MODE,
} from '@/lib/style/opening-reference'

const prompt = buildWriterPrompt()

describe('RULE 1: never point back, name the thing again', () => {
  it('states the rule as being about reference, not sentence length', () => {
    expect(prompt).toContain(
      'NO SENTENCE MAY DEPEND ON THE READER CARRYING A REFERENCE BACK FROM A PREVIOUS SENTENCE',
    )
    expect(prompt).toContain('NAME IT AGAIN')
  })

  it('names all three pointing shapes, so "one" is not left out', () => {
    // The measured fault was pronominal "one", which a rule about demonstratives alone
    // does not cover. If this list loses a member the rule stops describing the fault.
    const rule = prompt.slice(prompt.indexOf('NEVER POINT BACK'))
    expect(rule).toContain('demonstrative')
    expect(rule).toContain('bare pronoun')
    expect(rule).toMatch(/"one" or "ones"/)
  })

  // REWORDED 2026-09-02, and the emphasis is the point of the change rather than a
  // tidy-up. The rule used to lead with the within-bridge case and call it "the more
  // common half of it". Measured over the 41-prospect arm, 11 of 17 backward references
  // point from the BRIDGE INTO THE OBSERVATION and 7 point within the bridge, so the
  // claim was backwards. The rule now leads with the join and still covers both.
  it('leads with the join and still covers the within-bridge half', () => {
    expect(prompt).toContain('THIS APPLIES ACROSS THE JOIN FIRST')
    expect(prompt).toContain('It applies inside the\nbridge too')
    expect(prompt).not.toContain('the more common\nhalf of it')
  })
})

describe('RULE 2: never assert what the findings do not evidence', () => {
  it('covers how their work arrives', () => {
    expect(prompt).toContain('ANY CLAIM ABOUT HOW THEIR WORK ARRIVES MUST BE TRACEABLE TO A FINDING')
  })

  it('covers what they are or are not doing, which is the half that kept failing', () => {
    expect(prompt).toContain(
      'ANY CLAIM ABOUT WHAT THEY ARE OR ARE NOT DOING MUST BE TRACEABLE TO A FINDING',
    )
    // The specific inference that shipped: activity observed, absence concluded.
    expect(prompt).toContain('It is never evidence that')
  })

  it('closes the hedging escape by making an implication count as an assertion', () => {
    expect(prompt).toContain('IMPLYING IT COUNTS AS ASSERTING IT')
  })

  it('keeps the original narrower line rather than replacing it', () => {
    // The category-level rule is an addition. Dropping the concrete line it grew out of
    // would trade a specific instruction for a general one.
    expect(prompt).toContain(
      'Never name a channel, a source of work, or a way of operating that the observation does not',
    )
  })
})

describe('RULE 4: the closing question must ask what the offer line can answer', () => {
  it('states the rule', () => {
    expect(prompt).toContain(
      'THE QUESTION MUST ASK ABOUT SOMETHING THE APPROVED OFFER LINE CAN ACTUALLY ANSWER',
    )
  })

  it('says why the existing aim test cannot catch it', () => {
    expect(prompt).toContain('THE AIM TEST HAS A SECOND HALF, AND THE FIRST HALF CANNOT SEE IT')
  })

  it('extends the existing aim test rather than replacing it', () => {
    const first = prompt.indexOf('THE AIM TEST, run it on every draft')
    const second = prompt.indexOf('THE AIM TEST HAS A SECOND HALF')
    expect(first).toBeGreaterThan(-1)
    expect(second).toBeGreaterThan(first)
  })

  it('sends the fix to the bridge, not to the question alone', () => {
    expect(prompt).toContain('Rewrite the bridge first')
  })
})

describe('RULE ZERO: the surviving rules illustrate nothing', () => {
  // THE FAILURE THIS GUARDS. write-opening.ts has eight recorded instances of a worked
  // example being copied verbatim into a prospect's email. A quoted sentence inside a new
  // rule is a ready-made sentence to lift, so these carry none. RULE 3 was attribution
  // honesty and is gone with the rest of the attribution prose, so three remain.
  const RULES = [
    'NEVER POINT BACK. NAME THE THING AGAIN.',
    'NEVER ASSERT WHAT THE FINDINGS DO NOT EVIDENCE.',
    'THE AIM TEST HAS A SECOND HALF, AND THE FIRST HALF CANNOT SEE IT.',
  ]

  // The block belonging to one rule: from its heading to the next all-caps heading line.
  function blockFor(heading: string): string {
    const from = prompt.indexOf(heading)
    expect(from, `rule heading missing: ${heading}`).toBeGreaterThan(-1)
    const rest = prompt.slice(from + heading.length)
    const next = rest.search(/\n\n[A-Z][A-Z ,'"-]{18,}/)
    return next === -1 ? rest : rest.slice(0, next)
  }

  it.each(RULES)('%s carries no worked example sentence', heading => {
    const block = blockFor(heading)
    // A worked example in this prompt is a quoted sentence. Short quoted TOKENS are how the
    // rules name the shapes they ban, so the bar is a quoted span long enough to be copied.
    const quoted = [...block.matchAll(/"([^"]{25,})"/g)].map(m => m[1])
    expect(quoted, `quoted example span in "${heading}": ${JSON.stringify(quoted)}`).toEqual([])
  })

  it.each(RULES)('%s names no industry, buyer title, revenue band or currency', heading => {
    const block = blockFor(heading)
    expect(block).not.toMatch(/consult|coach|SaaS|logistics|agency|founder|CEO|director|VP\b/i)
    expect(block).not.toMatch(/[£$€]\s?\d/)
    expect(block).not.toMatch(/\b\d+\s?[km]\b/i)
  })
})

describe('the detector is wired onto the writer, in report mode', () => {
  beforeEach(() => vi.clearAllMocks())

  it('finds a demonstrative binding a noun in the bridge', () => {
    const hits = findOpeningReferences(
      'You spoke at the summit in March.',
      'The buyers in that room heard you once.',
    )
    expect(hits.map(h => h.phrase)).toContain('that room')
    expect(hits.find(h => h.phrase === 'that room')?.part).toBe('bridge')
  })

  it('finds pronominal "one", which the demonstrative signal cannot see', () => {
    // THE MEASURED GAP. All four faults the human read pulled out were this shape and the
    // existing detector caught none of them. A test that only covers demonstratives would
    // pass with this half deleted.
    const hits = findOpeningReferences(
      'You spoke at the summit in March.',
      'The ones who did not attend have not heard it yet.',
    )
    expect(hits.map(h => h.kind)).toContain('pronominal-one')
  })

  it('scans the observation as well as the bridge', () => {
    const hits = findOpeningReferences('You shipped a release. That release landed in March.', 'Buyers wait.')
    expect(hits.some(h => h.part === 'observation')).toBe(true)
  })

  it('counts a bare number as a number, not as a pointer', () => {
    // "one client" is a count. Matching it would fire on ordinary copy.
    expect(findOpeningReferences('You hired one engineer in March.', 'Work waits.')).toEqual([])
  })

  it('returns nothing for an opening that names its subjects again', () => {
    expect(findOpeningReferences(
      'You spoke at the summit in March.',
      'Buyers who missed the summit have not heard the argument yet.',
    )).toEqual([])
  })

  it('REPORT MODE: reports and rejects nothing', () => {
    expect(OPENING_REFERENCE_MODE).toBe('report')
    const failures = checkOpeningReferences(
      'You spoke at the summit in March.',
      'The buyers in that room heard you once.',
      { prospectId: 'p1' },
    )
    expect(failures).toEqual([])
    expect(logger.info).toHaveBeenCalledWith(
      'writer-back-reference: would reject',
      expect.objectContaining({ prospectId: 'p1', phrase: 'that room' }),
    )
  })

  it('checkOpeningGates runs it, and rejects nothing while it is reporting', () => {
    // THE WIRE ITSELF. In report mode the check returns [], so it is behaviourally
    // invisible and a test on the return value would pass with the call deleted. The log
    // line is the only observable, so it is what this asserts.
    const observation = 'You spoke at the summit in March.'
    const bridge = 'The buyers in that room heard you once.'
    const question = 'Is reaching the buyers who missed it something you are working on?'
    const failures = checkOpeningGates(
      `${observation}\n\n${bridge}\n\n${question}`,
      null,
      `${observation} ${bridge} summit buyers March`,
      undefined,
      { observation, bridge, question },
      { prospectId: 'p2' },
    )
    expect(logger.info).toHaveBeenCalledWith(
      'writer-back-reference: would reject',
      expect.objectContaining({ prospectId: 'p2', part: 'bridge', phrase: 'that room' }),
    )
    expect(failures.filter(f => f.includes('points back'))).toEqual([])
  })
})
