// ONE EMPTY FOLLOW-UP REFERENCE BORROWS THE OTHER. It never declines the pair.
//
// THE CASE THIS PROTECTS IS LIVE, NOT THEORETICAL. Measured on the only active messaging
// document on 2026-09-24: one variant's Email 3 has just TWO middle paragraphs, an opener
// and the closing question. Both are stripped, nothing survives, and under the rule this
// replaces every prospect on that variant lost BOTH follow-ups. Two of nine in that day's
// backfill.
//
// Fixtures are industry-neutral and none is copied from any client's document.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const createMock = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: createMock }
  },
}))

import { buildFollowupsFor } from '../produce-opening'
import { writeFollowups, buildFollowupSystemPrompt } from '../write-followups'
import { buildFollowupReference } from '../followup-frame'
import type { MessagingContent } from '@/lib/composition/compose-sequence'

const SIGNOFF = 'Sam\nExample Co'

/** A follow-up with a real middle: opener, register paragraph, closing question. */
const FULL = (register: string) => [
  '{{first_name}},',
  'Most operators in this position find the same thing happens each quarter.',
  register,
  'Does that match what you see?',
  SIGNOFF,
].join('\n\n')

/** A follow-up whose middle is an opener and a question and nothing else. */
const OPENER_AND_QUESTION = [
  '{{first_name}},',
  'Most operators in this position try to fix it by working later.',
  'Worth a quick call to see if it fits?',
  SIGNOFF,
].join('\n\n')

const REGISTER_2 = 'The gap is not the work itself. It is the week that disappears before the next job starts.'

const content = (email3Body: string): MessagingContent => ({
  variants: {
    D: {
      angle: 'test',
      emails: [
        { sequence_position: 1, body: '{{first_name}},\n\nOne.\n\nTwo.\n\nThree?\n\n' + SIGNOFF },
        { sequence_position: 2, body: FULL(REGISTER_2) },
        { sequence_position: 3, body: email3Body },
      ],
    },
  },
} as unknown as MessagingContent)

describe('buildFollowupsFor when one position strips to nothing', () => {
  it('borrows the sibling reference instead of declining', () => {
    // THE CONTROL ON THE PREMISE. If this stripped to something, the test below would pass
    // for the wrong reason and prove nothing about borrowing.
    expect(buildFollowupReference(OPENER_AND_QUESTION)).toBe('')

    const ref = buildFollowupsFor(content(OPENER_AND_QUESTION), 'D', 'Example Co')
    expect(ref).not.toBeNull()
    expect(ref!.borrowedPosition).toBe(3)
    expect(ref!.reference3).toBe(ref!.reference2)
    expect(ref!.reference3).toContain('The gap is not the work itself')
    // The unstripped bodies are untouched: they are the frames the gates count words in.
    expect(ref!.templateBody3).toBe(OPENER_AND_QUESTION)
  })

  it('borrows in the other direction too', () => {
    const flipped = {
      variants: {
        D: {
          angle: 'test',
          emails: [
            { sequence_position: 1, body: '{{first_name}},\n\nOne.\n\nTwo.\n\nThree?\n\n' + SIGNOFF },
            { sequence_position: 2, body: OPENER_AND_QUESTION },
            { sequence_position: 3, body: FULL(REGISTER_2) },
          ],
        },
      },
    } as unknown as MessagingContent
    const ref = buildFollowupsFor(flipped, 'D', 'Example Co')
    expect(ref!.borrowedPosition).toBe(2)
    expect(ref!.reference2).toBe(ref!.reference3)
  })

  it('reports no borrow when both have their own reference', () => {
    // POSITIVE CONTROL THE OTHER WAY. Without this, a builder that always reported a borrow
    // would pass every assertion above, and the prompt would claim a substitution that did
    // not happen on every prospect in the system.
    const ref = buildFollowupsFor(content(FULL('A different register paragraph entirely here.')), 'D', 'Example Co')
    expect(ref!.borrowedPosition).toBeNull()
    expect(ref!.reference2).not.toBe(ref!.reference3)
  })

  it('still declines when BOTH strip to nothing, which is a different case', () => {
    const both = {
      variants: {
        D: {
          angle: 'test',
          emails: [
            { sequence_position: 1, body: '{{first_name}},\n\nOne.\n\nTwo.\n\nThree?\n\n' + SIGNOFF },
            { sequence_position: 2, body: OPENER_AND_QUESTION },
            { sequence_position: 3, body: OPENER_AND_QUESTION },
          ],
        },
      },
    } as unknown as MessagingContent
    expect(buildFollowupsFor(both, 'D', 'Example Co')).toBeNull()
  })
})

describe('the writer is told when it is reading a borrowed reference', () => {
  beforeEach(() => createMock.mockReset())

  const reply = (email2: string, email3: string) => ({
    content: [{ type: 'text', text: `EMAIL2:\n${email2}\n\nEMAIL3:\n${email3}` }],
    usage: { input_tokens: 10, output_tokens: 10 },
  })

  /**
   * THE WRITER MAKES TWO DIFFERENT CALLS NOW, and one mock answering both is how a test
   * starts asserting the wrong thing. The fact-check runs after the deterministic gates
   * pass, and a writer reply fed to it parses as zero claims, which is itself a failure
   * ("an empty verdict is not a clean one"). So the mock answers by which system prompt it
   * was given.
   */
  const factCheckReply = (claims: unknown[]) => ({
    content: [{ type: 'text', text: JSON.stringify({ claims }) }],
    usage: { input_tokens: 10, output_tokens: 10 },
  })
  const CLEAN_CLAIMS = [
    { email: 2, claim: 'You keep the client work moving.', finding: 1, supported: true, why: 'finding 1 says so' },
    { email: 3, claim: 'You said yes to the current project.', finding: 1, supported: true, why: 'finding 1 says so' },
  ]
  const routed = (email2: string, email3: string) =>
    createMock.mockImplementation((args?: { system?: unknown }) => {
      const system = Array.isArray(args?.system)
        ? (args!.system as Array<{ text?: string }>).map(b => b.text ?? '').join('')
        : String(args?.system ?? '')
      return Promise.resolve(
        system.includes('You check whether an email')
          ? factCheckReply(CLEAN_CLAIMS)
          : reply(email2, email3),
      )
    })

  const PROSE_2 = [
    'You keep the client work moving while the next month of it goes unbuilt.',
    'A separate track keeps the first conversations arriving while you stay on the current job.',
    'Worth twenty minutes to see whether it fits how you work?',
  ].join('\n\n')

  const PROSE_3 = [
    'You said yes to the current project and the next one still has to come from somewhere.',
    'We keep that part running in the background all month.',
    'Want me to sketch what the first month looks like?',
  ].join('\n\n')

  const run = (email3Body: string) => {
    const ref = buildFollowupsFor(content(email3Body), 'D', 'Example Co')!
    return writeFollowups({
      apiKey: 'test', clientName: 'Example Co', buyer: 'an operator',
      email1Body: '{{first_name}},\n\nOne.\n\nTwo.\n\nThree?\n\n' + SIGNOFF,
      findings: 'They opened a second site in March.',
      // NUMBERED, because the fact-check cites BY NUMBER and code checks the number exists.
      // An unnumbered corpus has zero lines, so every citation into it is fabricated by
      // definition, which is what this fixture taught when it was written as plain prose.
      findingsEvidence: '1. They opened a second site in March.\n   source: web | a listings page',
      reference: ref, prospectId: 'borrow-test', offerLine: 'We run the outreach for you.',
      prospectFirstName: null, datedCandidates: [],
    })
  }

  it('WRITES BOTH FOLLOW-UPS when email 3 strips to empty', async () => {
    routed(PROSE_2, PROSE_3)
    const result = await run(OPENER_AND_QUESTION)
    // The claim in one line: the pair is not declined and both bodies exist.
    expect(result.email2.body, result.email2.failures.join(' | ')).not.toBeNull()
    expect(result.email3.body, result.email3.failures.join(' | ')).not.toBeNull()
  })

  it('names the substitution in the prompt it sends', async () => {
    routed(PROSE_2, PROSE_3)
    await run(OPENER_AND_QUESTION)
    const user = String(createMock.mock.calls[0][0].messages[0].content)
    expect(user).toContain('has no usable reference of its own')
    expect(user).toContain('Read it for register and length only')
  })

  it('says nothing about a substitution when there was none', async () => {
    routed(PROSE_2, PROSE_3)
    await run(FULL('A different register paragraph entirely here.'))
    const user = String(createMock.mock.calls[0][0].messages[0].content)
    expect(user).not.toContain('has no usable reference of its own')
  })

  it('the system prompt is unchanged by any of this, so it still caches', () => {
    expect(buildFollowupSystemPrompt()).toBe(buildFollowupSystemPrompt())
  })
})
