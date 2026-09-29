// THE SEAM, FOLLOW-UP HALF. The check runs inside writeFollowups' attempt loop, and what
// matters is not only that it runs but WHOSE EMAIL a verdict lands on.
//
// Judging needs as a PAIR would repeat the mistake measured on 2026-09-25: of the 44 pairs
// that fell back, 31 lost a passing email because its sibling failed. So a need rejected in
// email 2 must take email 2 down and leave email 3 shipping.
//
// Fixtures are invented and industry-neutral. The reference and the prose shapes are lifted
// from followup-per-email.test.ts so the two suites exercise the same gates.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const createMock = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: createMock } } }))

import { writeFollowups } from '../write-followups'
import { flattenPositioningText } from '../positioning-text'
import type { FollowupReference } from '../followup-frame'

const POSITIONING = {
  positioning_summary: 'We find and contact people who have never dealt with the client before.',
  value_themes: [{ theme: 'A steady flow of first conversations with people outside the existing network.' }],
}
const TEXT = flattenPositioningText(POSITIONING)

const SIGNOFF = 'Sam\nExample Co'
const template = (register: string) => [
  '{{first_name}},',
  'Most operators in this position find the same thing each quarter.',
  register,
  'Does that match what you see?',
  SIGNOFF,
].join('\n\n')

const REFERENCE: FollowupReference = {
  reference2: 'The gap is not the work itself. It is the week that disappears before the next job.',
  reference3: 'Consistency comes from removing yourself from the process.',
  templateBody2: template('The gap is not the work itself.'),
  templateBody3: template('Consistency comes from removing yourself.'),
  companyName: 'Northgate Fabrication',
  borrowedPosition: null,
}

const CLEAN_2 = [
  'You took the second unit on in March.',
  'A separate track keeps the first conversations arriving while the current job runs.',
  'Worth twenty minutes to see whether it fits?',
].join('\n\n')
const CLEAN_3 = [
  'You said yes to the second unit and the next job still has to come from somewhere.',
  'We keep that part running in the background all month.',
  'Want me to sketch the first month?',
].join('\n\n')

const say = (text: string) => ({ content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 10 } })

// The FACT-CHECK still carries a `supported` boolean: only the NEED-MATCH schema lost one.
// Two different checks, two different shapes, and stripping it here silently failed the pair
// before the need-match call was ever reached.
const FACT_CHECK_CLEAN = say(JSON.stringify({ claims: [
  { email: 2, claim: 'You took the second unit on in March.', finding: 1, supported: true, why: 'finding 1' },
  { email: 3, claim: 'You said yes to the second unit.', finding: 1, supported: true, why: 'finding 1' },
] }))

/** Email 2's need is not work this document describes; email 3's is. */
const NEEDS_SPLIT = say(JSON.stringify({ needs: [
  { id: 2, need: 'putting their own posts in front of more people', line: null, quote: '', why: 'the document describes contacting new people, not distributing their content' },
  { id: 3, need: 'first conversations outside the network', line: 2, quote: 'A steady flow of first conversations', why: 'same work' },
] }))

const NEEDS_BOTH_FINE = say(JSON.stringify({ needs: [
  { id: 2, need: 'first conversations outside the network', line: 2, quote: 'A steady flow of first conversations', why: 'same work' },
  { id: 3, need: 'first conversations outside the network', line: 2, quote: 'A steady flow of first conversations', why: 'same work' },
] }))

const systemOf = (args?: { system?: unknown }) =>
  Array.isArray(args?.system)
    ? (args!.system as Array<{ text?: string }>).map(b => b.text ?? '').join('')
    : String(args?.system ?? '')

const isNeedMatch = (args?: { system?: unknown }) => systemOf(args).includes('You check whether the NEEDS')

const needMatchCalls = () => createMock.mock.calls.filter(([a]) => isNeedMatch(a))

function route(needReply: ReturnType<typeof say>) {
  createMock.mockImplementation((args?: { system?: unknown }) => {
    const system = systemOf(args)
    if (system.includes('You check whether the NEEDS')) return Promise.resolve(needReply)
    if (system.includes('You check whether an email')) return Promise.resolve(FACT_CHECK_CLEAN)
    return Promise.resolve(say(`EMAIL2:\n${CLEAN_2}\nEMAIL3:\n${CLEAN_3}`))
  })
}

const run = (positioningText?: string) => writeFollowups({
  apiKey: 'test', clientName: 'Example Co', buyer: 'an operator',
  email1Body: '{{first_name}},\n\nOne.\n\nTwo.\n\nThree?\n\n' + SIGNOFF,
  offerLine: 'A separate track keeps the conversations arriving.',
  findings: 'They took on a second unit in March.',
  findingsEvidence: '1. They took on a second unit in March.\n   source: web | a listings page',
  reference: REFERENCE, prospectId: 'need-match-followups-test', prospectFirstName: null,
  datedCandidates: [], now: new Date('2026-09-25T00:00:00Z'),
  positioningText,
})

beforeEach(() => createMock.mockReset())

describe('the need-match check reaches emails 2 and 3', () => {
  it('runs on a pair the gates and the fact-check both accepted, with the document', async () => {
    route(NEEDS_BOTH_FINE)
    const r = await run(TEXT)

    expect(needMatchCalls()).toHaveLength(1)
    const [args] = needMatchCalls()[0] as [{ system: Array<{ text: string }>; messages: Array<{ content: string }> }]
    expect(args.system[0].text).toContain('2. [value_themes[0].theme] A steady flow')
    // Both emails in one call, because they are judged against the same document and a
    // second call would be a second bill for the same prefix.
    const user = args.messages[0].content
    expect(user).toContain('Email 2')
    expect(user).toContain('Email 3')
    expect(user).toContain(CLEAN_2)
    expect(user).toContain(CLEAN_3)

    // Nothing was rejected, so both ship.
    expect(r.email2.prose, r.email2.failures.join(' | ')).not.toBeNull()
    expect(r.email3.prose, r.email3.failures.join(' | ')).not.toBeNull()
  })

  it('takes down only the email whose need the document does not cover', async () => {
    route(NEEDS_SPLIT)
    const r = await run(TEXT)

    // THE PER-EMAIL PROPERTY. Email 3 passed everything and must not be discarded for its
    // sibling, which is the failure that cost 31 of 44 pairs.
    expect(r.email3.prose).not.toBeNull()
    expect(r.email2.prose).toBeNull()
    expect(r.email2.failures.join(' | ')).toContain('putting their own posts in front of more people')
    expect(r.email3.failures.join(' | ')).not.toContain('putting their own posts')
  })

  it('does not run at all when the client has no positioning document', async () => {
    route(NEEDS_SPLIT)
    const r = await run(undefined)

    expect(needMatchCalls()).toHaveLength(0)
    // Positive control: the run really happened and the fact-check really ran, so the
    // absent need-match call is the off switch rather than a run that never started.
    expect(createMock.mock.calls.some(([a]) => systemOf(a).includes('You check whether an email'))).toBe(true)
    expect(r.email2.prose).not.toBeNull()
    expect(r.email3.prose).not.toBeNull()
  })
})
