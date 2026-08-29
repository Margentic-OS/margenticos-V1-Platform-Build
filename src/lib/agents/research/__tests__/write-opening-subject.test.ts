// The Email 1 subject, written by the writer from its own observation.
//
// WHAT THESE COVER. Parsing the fourth block; the three soft checks; and the one property
// that matters more than any of them, which is that a rejected subject costs the prospect
// nothing. A subject failure that consumed an attempt would trade a subject for a body,
// and an exhausted attempt ships the approved template, which is worse copy than any
// subject this gate would reject.
//
// Every fixture below is invented and industry-neutral. Nothing is copied from the prompt,
// from the database, or from another test: a fixture lifted from the prompt would pass a
// traceability check for the wrong reason.

import { describe, it, expect } from 'vitest'
import {
  parseWriterOutput,
  checkSubjectGates,
  buildWriterPrompt,
} from '../write-opening'
import {
  composeEmail1WithOpening,
  type MessagingContent,
} from '@/lib/composition/compose-sequence'
import { composedToVariables, assertCompleteVariables } from '@/lib/composition/custom-variables'
import { EMAIL_SUBJECT_LIMITS } from '@/agents/messaging-generation-agent'

const FINDINGS = [
  'Kestrel Loft Systems published a hiring page for two installation technicians.',
  'The company operates from three depots listed on its contact page.',
  'A trade directory records the business as founded in 2019.',
].join('\n')

const FOUR_BLOCKS = [
  'OBSERVATION: Two technician roles are open across three depots.',
  'BRIDGE: Capacity arrives before the work that pays for it does. That order is uncomfortable.',
  'QUESTION: Is filling that gap something you are looking at?',
  'SUBJECT: two roles, three depots',
].join('\n')

// ─── Parsing ────────────────────────────────────────────────────────────────

describe('parseWriterOutput reads the SUBJECT block', () => {
  it('returns the subject when the block is present, alongside the other three', () => {
    const out = parseWriterOutput(FOUR_BLOCKS)
    expect(out.subject).toBe('two roles, three depots')
    expect(out.observation).toBe('Two technician roles are open across three depots.')
    expect(out.bridge).toBe('Capacity arrives before the work that pays for it does. That order is uncomfortable.')
    expect(out.question).toBe('Is filling that gap something you are looking at?')
  })

  it('returns an empty subject when the block is absent, and still parses the other three', () => {
    const raw = FOUR_BLOCKS.split('\n').slice(0, 3).join('\n')
    const out = parseWriterOutput(raw)
    expect(out.subject).toBe('')
    expect(out.observation).toBe('Two technician roles are open across three depots.')
    expect(out.bridge).toBe('Capacity arrives before the work that pays for it does. That order is uncomfortable.')
    expect(out.question).toBe('Is filling that gap something you are looking at?')
  })

  it('keeps the subject out of the question, which is the boundary that used to be incidental', () => {
    const out = parseWriterOutput(FOUR_BLOCKS)
    expect(out.question).not.toContain('SUBJECT')
    expect(out.question).not.toContain('depots')
  })

  it('does not leak SUBJECT text into the observation on the unlabelled fallback path', () => {
    // No OBSERVATION, BRIDGE or OPENING label at all: the fallback treats what it is given
    // as prose. Without the strip, the literal label would become the email's first line.
    const raw = [
      'Two technician roles are open across three depots.',
      '',
      'Capacity arrives before the work that pays for it does.',
      '',
      'SUBJECT: two roles, three depots',
    ].join('\n')
    const out = parseWriterOutput(raw)
    expect(out.subject).toBe('two roles, three depots')
    expect(out.observation).not.toContain('SUBJECT')
    expect(out.bridge).not.toContain('SUBJECT')
    expect(out.opening).not.toContain('SUBJECT')
    expect(out.observation).toBe('Two technician roles are open across three depots.')
  })

  it('does not leak SUBJECT text into a legacy single OPENING block either', () => {
    const raw = [
      'OPENING: Two technician roles are open across three depots.',
      'SUBJECT: two roles, three depots',
    ].join('\n')
    const out = parseWriterOutput(raw)
    expect(out.subject).toBe('two roles, three depots')
    expect(out.observation).toBe('Two technician roles are open across three depots.')
    expect(out.opening).not.toContain('SUBJECT')
  })
})

// ─── The three soft checks ──────────────────────────────────────────────────

describe('checkSubjectGates', () => {
  it('passes a subject built only from words in the findings', () => {
    expect(checkSubjectGates('two roles, three depots', FINDINGS)).toEqual([])
  })

  it('rejects a subject naming something no finding mentions', () => {
    const failures = checkSubjectGates('the Harrowgate depot rollout', FINDINGS)
    expect(failures.join(' ')).toContain('Harrowgate')
    expect(failures.join(' ')).toContain('not traceable')
  })

  it('rejects a subject over the character cap', () => {
    const over = 'a'.repeat(EMAIL_SUBJECT_LIMITS.email1MaxChars + 1)
    const failures = checkSubjectGates(over, FINDINGS)
    expect(failures.join(' ')).toContain('cap is')
    // The boundary itself passes: the cap is a maximum, not an exclusive bound.
    expect(checkSubjectGates('a'.repeat(EMAIL_SUBJECT_LIMITS.email1MaxChars), FINDINGS)).toEqual([])
  })

  it('rejects a subject containing a question mark', () => {
    const failures = checkSubjectGates('two roles, three depots?', FINDINGS)
    expect(failures.join(' ')).toContain('question')
  })

  it('rejects a subject quoting a currency amount from the prospect record', () => {
    // Deliberately traceable: the figure is IN the findings below, so the traceability
    // check above passes it. Being in the findings is exactly what makes it dangerous,
    // which is why this needs its own check rather than a wider traceability net.
    const findingsWithFigure = `${FINDINGS}\nA filing lists turnover of £750K for the year.`
    const failures = checkSubjectGates('growth past £750K', findingsWithFigure)
    expect(failures.join(' ')).toContain("from the prospect's record")
    // And it really did get past traceability, which is the point of the fixture.
    expect(failures.join(' ')).not.toContain('not traceable')
  })

  it('rejects a headcount in the subject', () => {
    const findingsWithFigure = `${FINDINGS}\nA directory lists a team of 12.`
    expect(checkSubjectGates('a team of 12', findingsWithFigure).join(' '))
      .toContain("from the prospect's record")
  })

  it('leaves ordinary numbers alone, so the check is not a ban on digits', () => {
    expect(checkSubjectGates('two roles, three depots', FINDINGS)).toEqual([])
  })

  it('says nothing about an absent subject, which is the fallback working', () => {
    expect(checkSubjectGates('', FINDINGS)).toEqual([])
    expect(checkSubjectGates('   ', FINDINGS)).toEqual([])
  })
})

// ─── Composition ────────────────────────────────────────────────────────────

const AUTHORED_SUBJECT = 'a note about capacity'

const MESSAGING: MessagingContent = {
  variants: {
    A: {
      emails: [
        {
          sequence_position: 1,
          subject_line: AUTHORED_SUBJECT,
          subject_char_count: AUTHORED_SUBJECT.length,
          body: [
            '{{first_name}}',
            'The authored opener that the writer replaces.',
            'We keep the work arriving without you chasing it.',
            'Worth a short conversation?',
            'Robin\nKestrel Partners',
          ].join('\n\n'),
          word_count: 30,
        },
        {
          sequence_position: 2,
          subject_line: null,
          subject_char_count: 0,
          body: '{{first_name}}\n\nA second email.\n\nRobin\nKestrel Partners',
          word_count: 10,
        },
      ],
    },
  },
}

describe('composeEmail1WithOpening carries the subject', () => {
  it('substitutes the written subject when one is given', () => {
    const email = composeEmail1WithOpening(
      MESSAGING, 'A', 'A written observation.', null, 'Robin', 'two roles, three depots',
    )
    expect(email.subject_line).toBe('two roles, three depots')
    expect(email.subject_char_count).toBe('two roles, three depots'.length)
  })

  it('keeps the authored subject when none is given, which is the template side of the judge', () => {
    const email = composeEmail1WithOpening(MESSAGING, 'A', 'A written observation.', null, 'Robin')
    expect(email.subject_line).toBe(AUTHORED_SUBJECT)
  })

  it('keeps the authored subject when the written one is empty, which is a discarded subject', () => {
    const email = composeEmail1WithOpening(MESSAGING, 'A', 'A written observation.', null, 'Robin', '')
    expect(email.subject_line).toBe(AUTHORED_SUBJECT)
  })

  it('still satisfies the upload completeness invariant', () => {
    const email1 = composeEmail1WithOpening(
      MESSAGING, 'A', 'A written observation.', null, 'Robin', 'two roles, three depots',
    )
    const email2 = MESSAGING.variants!.A.emails[1]
    const vars = composedToVariables([email1, { ...email2, word_count: 10 }], 'Robin')
    expect(() => assertCompleteVariables(vars, 2)).not.toThrow()
    expect(vars.m_subject_1).toBe('two roles, three depots')
    // Emails 2 to 4 thread under Email 1 and keep their empty subject.
    expect(vars.m_subject_2).toBe('')
  })
})

// ─── Rule Zero on the prompt itself ─────────────────────────────────────────

describe('the subject instructions state a shape and show no example', () => {
  const p = buildWriterPrompt()

  it('states the firmographic ban at category level', () => {
    const flat = p.replace(/\s+/g, ' ')
    expect(flat).toContain('No figure from their record: no revenue, no headcount, no funding, no money amount.')
  })

  it('states each rule at category level', () => {
    const flat = p.replace(/\s+/g, ' ')
    expect(flat).toContain('All lower case.')
    expect(flat).toContain('No full stop, no question mark and no exclamation mark at the end.')
    expect(flat).toContain("Never their first name and never their company's name.")
    expect(flat).toContain(`At most ${EMAIL_SUBJECT_LIMITS.email1MaxChars} characters`)
    expect(flat).toContain('It comes from your observation.')
  })

  it('carries no example subject line', () => {
    // An example in a prompt gets reproduced verbatim. The subject block is described by
    // its placeholder and by rules, and the only text following "SUBJECT:" anywhere in the
    // prompt is that placeholder.
    const afterLabel = [...p.matchAll(/SUBJECT:[ \t]*(.*)/g)].map(m => m[1].trim())
    expect(afterLabel).toEqual(['<the subject line, on one line>'])

    // And nothing quotes a candidate subject beside the rules.
    const rulesBlock = p.slice(p.indexOf('THE SUBJECT LINE'), p.indexOf('Return your answer'))
    expect(rulesBlock).not.toMatch(/["“”]/)
  })
})
