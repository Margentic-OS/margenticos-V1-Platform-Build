// A PERSONALISED FOLLOW-UP SAYS ONLY WHAT THIS CLIENT DOES, AND NEVER THAT THE READER
// ALREADY HAS WHAT THE OFFER PROVIDES. Operator instruction, 2026-10-03.
//
// The faults he read, paraphrased and invented here so no real copy is committed:
//
//   an Email 2 after a prospect spoke at an event said the sender would go and contact the
//   people who saw them there. The client's scope is finding THE CLIENT'S buyers; reaching
//   the prospect's own audience is not in it.
//
//   an Email 3 asserted something about firms like the reader that the findings never said.
//
// The checker is a model call and the tests stub it, so what is proved here is the WIRING:
// the scope reaches the checker and the writer, the checker's verdict is acted on per email,
// an answer missing the verdict fails closed, and with no brief nothing changes. The phrase
// pass is code and is proved outright, including that it spends no model call.
//
// RULE ZERO. Every fixture is invented and industry-neutral.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const createMock = vi.fn()
vi.mock('@anthropic-ai/sdk', async importOriginal => ({
  ...(await importOriginal<typeof import('@anthropic-ai/sdk')>()),
  default: class { messages = { create: createMock } },
}))

import { writeFollowups } from '../write-followups'
import { findNeverClaimPhrases, followupScopeFromMessaging, type FollowupScope } from '../followup-scope'
import type { FollowupReference } from '../followup-frame'

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

// THE CLIENT'S SCOPE. Finds the client's buyers and books first meetings with them.
const MESSAGING = {
  outbound_brief: {
    scope: {
      does: [
        { id: 'D1', statement: 'Finds the buyers who fit the client and books first meetings with them.', source: 'invented' },
      ],
      never_claims: [
        { id: 'N1', statement: 'Never promises a number of meetings or a guaranteed result.', phrases: ['guaranteed', 'guarantee'], source: 'invented' },
      ],
    },
    outcomes: [
      { id: 'O1', statement: 'First meetings with buyers who fit can arrive while you deliver.', source: 'invented' },
    ],
  },
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

// PLANTED: the sender promises to contact the PROSPECT's own audience.
const AUDIENCE_SENTENCE = 'We reach the people who saw you there and pitch them for you.'
const OUT_OF_SCOPE_2 = [
  'You took the second unit on in March.',
  AUDIENCE_SENTENCE,
  'Worth twenty minutes to see whether it fits?',
].join('\n\n')

// PLANTED: the reader is told they already have what the offer provides.
const HAS_OUTCOME_SENTENCE = 'With the meetings already arriving, the next job is in hand.'
const HAS_OUTCOME_3 = [
  'You said yes to the second unit and the next job still has to come from somewhere.',
  HAS_OUTCOME_SENTENCE,
  'Want me to sketch the first month?',
].join('\n\n')

// PLANTED: a never_claims phrase. Both emails carry it so no checker call is owed at all.
const PHRASE_2 = [
  'You took the second unit on in March.',
  'We keep first meetings arriving, guaranteed, while the current job runs.',
  'Worth twenty minutes to see whether it fits?',
].join('\n\n')
const PHRASE_3 = [
  'You said yes to the second unit and the next job still has to come from somewhere.',
  'We keep that part running all month, and the result is Guaranteed.',
  'Want me to sketch the first month?',
].join('\n\n')

// Fails a deterministic gate (opens on a generality), so email 2 is rewritten whatever.
const GATE_FAIL = [
  'Adding capacity usually raises a question about where the next work comes from.',
  'That question is worth answering early.',
  'Worth a quick call?',
].join('\n\n')

const reply = (text: string) => ({ content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 10 } })

const CLAIMS = [
  { email: 2, claim: 'You took the second unit on in March.', finding: 1, supported: true, why: 'finding 1' },
  { email: 3, claim: 'You said yes to the second unit and the next job still has to come from somewhere.', finding: 1, supported: true, why: 'finding 1' },
]
const cleanEmail = (email: number, senderClaims: Array<Record<string, unknown>> = []) =>
  ({ email, sender_claims: senderClaims, reader_has_outcome: null, presumes_about_reader: null })
const CLEAN_SCOPE = [
  cleanEmail(2),
  cleanEmail(3, [{ claim: 'We keep that part running in the background all month.', covered_by: 'D1', violates: null }]),
]

const isChecker = (args?: { system?: unknown }) => {
  const system = Array.isArray(args?.system)
    ? (args!.system as Array<{ text?: string }>).map(b => b.text ?? '').join('')
    : String(args?.system ?? '')
  return system.includes('You check whether an email')
}

/** The writer answers from `writerReplies`; the checker answers `checker` (JSON body). */
function route(writerReplies: string[], checker: Record<string, unknown>) {
  let n = 0
  createMock.mockImplementation((args?: { system?: unknown }) => {
    if (isChecker(args)) return Promise.resolve(reply(JSON.stringify(checker)))
    return Promise.resolve(reply(writerReplies[Math.min(n++, writerReplies.length - 1)]))
  })
}

const checkerCalls = () => createMock.mock.calls.filter(c => isChecker(c[0]))
const writerCalls = () => createMock.mock.calls.filter(c => !isChecker(c[0]))

const run = (messagingContent?: unknown) => writeFollowups({
  apiKey: 'test', clientName: 'Example Co', buyer: 'an operator',
  email1Body: '{{first_name}},\n\nOne.\n\nTwo.\n\nThree?\n\n' + SIGNOFF,
  offerLine: 'A separate track keeps the conversations arriving.',
  findings: 'They took on a second unit in March.',
  findingsEvidence: '1. They took on a second unit in March.\n   source: web | a listings page',
  reference: REFERENCE, prospectId: 'scope-test', prospectFirstName: null,
  datedCandidates: [], now: new Date('2026-10-03T00:00:00Z'),
  messagingContent,
})

describe('the never_claims phrase pass', () => {
  const scope = followupScopeFromMessaging(MESSAGING) as FollowupScope

  it('reads the scope out of the messaging document', () => {
    expect(scope.does.map(d => d.id)).toEqual(['D1'])
    expect(scope.never_claims[0].phrases).toEqual(['guaranteed', 'guarantee'])
    expect(scope.outcomes.map(o => o.id)).toEqual(['O1'])
  })

  it('finds a phrase as a whole word, in any case', () => {
    expect(findNeverClaimPhrases('The result is Guaranteed.', scope).map(h => h.phrase)).toEqual(['guaranteed'])
  })

  it('does not find a phrase inside a longer word', () => {
    expect(findNeverClaimPhrases('Nothing here is unguaranteed or guaranteeing.', scope)).toEqual([])
  })

  it('no document, or a document with no brief, is no scope', () => {
    expect(followupScopeFromMessaging(undefined)).toBeNull()
    expect(followupScopeFromMessaging({ variants: {} })).toBeNull()
  })
})

describe('a personalised follow-up stays within the client brief scope', () => {
  beforeEach(() => { createMock.mockReset() })

  it('REFUSES a follow-up that says the sender will contact the prospect audience', async () => {
    route([`EMAIL2:\n${OUT_OF_SCOPE_2}\nEMAIL3:\n${CLEAN_3}`], {
      claims: CLAIMS,
      emails: [
        cleanEmail(2, [{ claim: AUDIENCE_SENTENCE, covered_by: null, violates: null }]),
        CLEAN_SCOPE[1],
      ],
    })
    const r = await run(MESSAGING)
    expect(r.email2.prose).toBeNull()
    expect(r.email2.failures.join(' | ')).toContain('outside what this client does')
    expect(r.email2.failures.join(' | ')).toContain(AUDIENCE_SENTENCE)
    // Email 3 was sound and is kept on its own.
    expect(r.email3.prose, r.email3.failures.join(' | ')).not.toBeNull()

    // The checker was shown the client's scope, from the brief, and asked the question.
    const sent = checkerCalls()[0][0] as { system: string; messages: Array<{ content: string }> }
    expect(sent.messages[0].content).toContain('Finds the buyers who fit the client and books first meetings with them.')
    expect(sent.messages[0].content).toContain('Never promises a number of meetings or a guaranteed result.')
    expect(sent.messages[0].content).toContain('First meetings with buyers who fit can arrive while you deliver.')
    expect(sent.messages[0].content).toContain("The sender's scope")
    expect(sent.system).toContain('sender_claims')
    expect(sent.system).toContain('reader_has_outcome')
  })

  it('REFUSES a follow-up that implies the reader already has the outcome', async () => {
    route([`EMAIL2:\n${CLEAN_2}\nEMAIL3:\n${HAS_OUTCOME_3}`], {
      claims: CLAIMS,
      emails: [cleanEmail(2), { ...cleanEmail(3), reader_has_outcome: HAS_OUTCOME_SENTENCE }],
    })
    const r = await run(MESSAGING)
    expect(r.email3.prose).toBeNull()
    expect(r.email3.failures.join(' | ')).toContain('implies the reader already has what the offer provides')
    expect(r.email2.prose, r.email2.failures.join(' | ')).not.toBeNull()
  })

  it('REFUSES a sentence about their firm that the findings do not establish', async () => {
    const presumed = 'You said yes to the second unit and the next job still has to come from somewhere.'
    route([`EMAIL2:\n${CLEAN_2}\nEMAIL3:\n${CLEAN_3}`], {
      claims: CLAIMS,
      emails: [cleanEmail(2), { ...CLEAN_SCOPE[1], presumes_about_reader: presumed }],
    })
    const r = await run(MESSAGING)
    expect(r.email3.prose).toBeNull()
    expect(r.email3.failures.join(' | ')).toContain('asserts something about their firm that the findings do not establish')
  })

  it('REFUSES a never_claims phrase with no checker call at all', async () => {
    route([`EMAIL2:\n${PHRASE_2}\nEMAIL3:\n${PHRASE_3}`], { claims: CLAIMS, emails: CLEAN_SCOPE })
    const r = await run(MESSAGING)
    expect(r.email2.prose).toBeNull()
    expect(r.email3.prose).toBeNull()
    expect(r.email2.failures.join(' | ')).toContain('which this client never claims')
    expect(r.email3.failures.join(' | ')).toContain('"guaranteed"')
    expect(checkerCalls()).toHaveLength(0)
    // The writer was asked again, so the phrase failure travelled back as feedback.
    expect(writerCalls().length).toBe(2)
  })

  it('PASSES a sound follow-up pair', async () => {
    route([`EMAIL2:\n${CLEAN_2}\nEMAIL3:\n${CLEAN_3}`], { claims: CLAIMS, emails: CLEAN_SCOPE })
    const r = await run(MESSAGING)
    expect(r.email2.prose, r.email2.failures.join(' | ')).toBe(CLEAN_2)
    expect(r.email3.prose, r.email3.failures.join(' | ')).toBe(CLEAN_3)
    expect(r.retries_used).toBe(0)
  })

  it('FAILS CLOSED when the checker returns no scope verdict for an email', async () => {
    route([`EMAIL2:\n${CLEAN_2}\nEMAIL3:\n${CLEAN_3}`], { claims: CLAIMS, emails: [CLEAN_SCOPE[0]] })
    const r = await run(MESSAGING)
    expect(r.email3.prose).toBeNull()
    expect(r.email3.failures.join(' | ')).toContain('returned no scope verdict')
    expect(r.email2.prose).not.toBeNull()
  })

  it('FAILS a sender sentence the checker never returned as a sender claim', async () => {
    // A short verdict is the failure that looks clean: email 3 says what the sender does,
    // and the checker listed nothing for it.
    route([`EMAIL2:\n${CLEAN_2}\nEMAIL3:\n${CLEAN_3}`], { claims: CLAIMS, emails: [cleanEmail(2), cleanEmail(3)] })
    const r = await run(MESSAGING)
    expect(r.email3.prose).toBeNull()
    expect(r.email3.failures.join(' | ')).toContain('We keep that part running in the background all month.')
  })

  it('CHECKS email 3 even when email 2 failed the deterministic gates', async () => {
    // Until 2026-10-03 the checker ran only when email 2 passed the gates, so an email 3
    // beside a failing email 2 was banked with no check of any kind.
    const sentence = 'We keep that part running in the background all month.'
    route([`EMAIL2:\n${GATE_FAIL}\nEMAIL3:\n${CLEAN_3}`], {
      claims: CLAIMS,
      emails: [cleanEmail(2), cleanEmail(3, [{ claim: sentence, covered_by: null, violates: null }])],
    })
    const r = await run(MESSAGING)
    expect(checkerCalls().length).toBeGreaterThan(0)
    expect(r.email3.prose).toBeNull()
    expect(r.email3.failures.join(' | ')).toContain('outside what this client does')
  })

  it('TELLS THE WRITER the scope, so it can write within it the first time', async () => {
    route([`EMAIL2:\n${CLEAN_2}\nEMAIL3:\n${CLEAN_3}`], { claims: CLAIMS, emails: CLEAN_SCOPE })
    await run(MESSAGING)
    const user = String((writerCalls()[0][0] as { messages: Array<{ content: string }> }).messages[0].content)
    expect(user).toContain('Finds the buyers who fit the client and books first meetings with them.')
    expect(user).toContain('Never promises a number of meetings or a guaranteed result.')
    expect(user).toContain('"guaranteed"')
    expect(user).toContain('First meetings with buyers who fit can arrive while you deliver.')
  })
})

describe('with no brief, follow-ups behave exactly as before', () => {
  beforeEach(() => { createMock.mockReset() })

  it('asks no scope question, and a verdict with no scope field passes', async () => {
    route([`EMAIL2:\n${OUT_OF_SCOPE_2}\nEMAIL3:\n${CLEAN_3}`], { claims: CLAIMS })
    const r = await run(undefined)
    expect(r.email2.prose, r.email2.failures.join(' | ')).toBe(OUT_OF_SCOPE_2)
    expect(r.email3.prose, r.email3.failures.join(' | ')).toBe(CLEAN_3)
    const sent = checkerCalls()[0][0] as { system: string; messages: Array<{ content: string }> }
    expect(sent.system).not.toContain('sender_claims')
    expect(sent.messages[0].content).not.toContain("The sender's scope")
    const user = String((writerCalls()[0][0] as { messages: Array<{ content: string }> }).messages[0].content)
    expect(user).not.toContain('What the sender does')
  })

  it('a never_claims-looking word is not refused when there is no brief to say so', async () => {
    route([`EMAIL2:\n${PHRASE_2}\nEMAIL3:\n${CLEAN_3}`], { claims: CLAIMS })
    const r = await run(undefined)
    expect(r.email2.failures.join(' | ')).not.toContain('never claims')
  })
})
