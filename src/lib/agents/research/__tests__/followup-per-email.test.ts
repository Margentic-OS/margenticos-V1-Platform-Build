// EACH FOLLOW-UP IS ACCEPTED ON ITS OWN, AND A RETRY REWRITES ONLY WHAT FAILED.
//
// ═════════════════════════════════════════════════════════════════════════════
// Measured on the 44 pairs that fell back on 2026-09-25: THIRTY-ONE of them, seventy per
// cent, lost a passing email because its sibling failed. 21 discarded a clean email 2 for an
// email 3 fault; 10 the reverse. That copy existed, passed every gate it was subject to, and
// was thrown away.
//
// Fixtures are industry-neutral.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const createMock = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: createMock } } }))

import { writeFollowups } from '../write-followups'
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

// Email 2 is clean. Email 3 opens on a generality, which the callback gate rejects.
const CLEAN_2 = [
  'You took the second unit on in March.',
  'A separate track keeps the first conversations arriving while the current job runs.',
  'Worth twenty minutes to see whether it fits?',
].join('\n\n')
const BAD_3 = [
  'Adding capacity usually raises a question about where the next work comes from.',
  'That question is worth answering early.',
  'Worth a quick call?',
].join('\n\n')
const CLEAN_3 = [
  'You said yes to the second unit and the next job still has to come from somewhere.',
  'We keep that part running in the background all month.',
  'Want me to sketch the first month?',
].join('\n\n')

const reply = (text: string) => ({
  content: [{ type: 'text', text }],
  usage: { input_tokens: 10, output_tokens: 10 },
})
const FACT_CHECK_CLEAN = {
  content: [{ type: 'text', text: JSON.stringify({ claims: [
    { email: 2, claim: 'You took the second unit on in March.', finding: 1, supported: true, why: 'finding 1' },
    { email: 3, claim: 'You said yes to the second unit.', finding: 1, supported: true, why: 'finding 1' },
  ] }) }],
  usage: { input_tokens: 10, output_tokens: 10 },
}

/** Routes by system prompt: the writer and the fact-check are two different calls. */
function route(writerReplies: string[]) {
  let n = 0
  createMock.mockImplementation((args?: { system?: unknown }) => {
    const system = Array.isArray(args?.system)
      ? (args!.system as Array<{ text?: string }>).map(b => b.text ?? '').join('')
      : String(args?.system ?? '')
    if (system.includes('You check whether an email')) return Promise.resolve(FACT_CHECK_CLEAN)
    return Promise.resolve(reply(writerReplies[Math.min(n++, writerReplies.length - 1)]))
  })
}

const run = () => writeFollowups({
  apiKey: 'test', clientName: 'Example Co', buyer: 'an operator',
  email1Body: '{{first_name}},\n\nOne.\n\nTwo.\n\nThree?\n\n' + SIGNOFF,
  offerLine: 'A separate track keeps the conversations arriving.',
  findings: 'They took on a second unit in March.',
  findingsEvidence: '1. They took on a second unit in March.\n   source: web | a listings page',
  reference: REFERENCE, prospectId: 'per-email-test', prospectFirstName: null,
  datedCandidates: [], now: new Date('2026-09-25T00:00:00Z'),
})

describe('an email is accepted on its own', () => {
  beforeEach(() => createMock.mockReset())

  it('KEEPS a passing email 2 when email 3 fails on every attempt', async () => {
    // THE CASE THAT COST 21 PROSPECTS. Before this change both came back null.
    route([`EMAIL2:\n${CLEAN_2}\nEMAIL3:\n${BAD_3}`])
    const r = await run()
    expect(r.email2.prose, r.email2.failures.join(' | ')).not.toBeNull()
    expect(r.email2.body).not.toBeNull()
    expect(r.email3.prose).toBeNull()
    expect(r.email3.failures.length).toBeGreaterThan(0)
  })

  it('KEEPS a passing email 3 when email 2 fails, which is the other 10', async () => {
    route([`EMAIL2:\n${BAD_3}\nEMAIL3:\n${CLEAN_3}`])
    const r = await run()
    expect(r.email3.prose, r.email3.failures.join(' | ')).not.toBeNull()
    expect(r.email2.prose).toBeNull()
  })

  it('POSITIVE CONTROL: both ship when both pass, in one attempt', async () => {
    // Without this the change would be indistinguishable from a writer that never retries.
    route([`EMAIL2:\n${CLEAN_2}\nEMAIL3:\n${CLEAN_3}`])
    const r = await run()
    expect(r.email2.prose).not.toBeNull()
    expect(r.email3.prose).not.toBeNull()
    expect(r.retries_used).toBe(0)
  })

  it('POSITIVE CONTROL: both fall back when both fail, so the gates still gate', async () => {
    route([`EMAIL2:\n${BAD_3}\nEMAIL3:\n${BAD_3}`])
    const r = await run()
    expect(r.email2.prose).toBeNull()
    expect(r.email3.prose).toBeNull()
  })
})

describe('a retry rewrites only the failing email', () => {
  beforeEach(() => createMock.mockReset())

  it('asks for EMAIL3 alone, and keeps the accepted email 2 verbatim', async () => {
    // First attempt: 2 clean, 3 bad. Second: only 3 is asked for, and it comes back clean.
    route([
      `EMAIL2:\n${CLEAN_2}\nEMAIL3:\n${BAD_3}`,
      `EMAIL3:\n${CLEAN_3}`,
    ])
    const r = await run()
    expect(r.email2.prose).toBe(CLEAN_2)
    expect(r.email3.prose).not.toBeNull()

    // The retry's user message must say so, and must not quote email 2's copy back.
    const writerCalls = createMock.mock.calls.filter(c => {
      const sys = Array.isArray(c[0]?.system) ? c[0].system.map((b: { text?: string }) => b.text ?? '').join('') : String(c[0]?.system ?? '')
      return !sys.includes('You check whether an email')
    })
    expect(writerCalls.length).toBeGreaterThan(1)
    const retry = String(writerCalls[1][0].messages[0].content)
    expect(retry).toContain('Only EMAIL3 is being rewritten')
    expect(retry).toContain('Return ONLY the EMAIL3 block')
    expect(retry).not.toContain('You wrote, as email 2:')
  })

  it('does not ask the model to reproduce an accepted email', async () => {
    // Asking again risks a worse version of copy that was already good, and costs output
    // tokens for nothing. The accepted prose is reused from memory, not re-parsed.
    route([
      `EMAIL2:\n${CLEAN_2}\nEMAIL3:\n${BAD_3}`,
      `EMAIL3:\n${CLEAN_3}`,
    ])
    const r = await run()
    expect(r.email2.prose).toBe(CLEAN_2)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// THE WRITER IS GIVEN EACH EVENT'S DATE AND TODAY'S DATE.
//
// The event-year gate was the largest single cause of follow-up loss, 17 of 44 pairs on
// 2026-09-25, every one an event from a previous year named without its year. The writer was
// being asked for a year it had never been given: buildFindingsBlock rendered the
// observation, the source, the provenance and the counter-reading, and NOT c.date. A date
// reached it only when synthesis happened to write one into the observation prose.
describe('the follow-up writer is told the dates', () => {
  beforeEach(() => createMock.mockReset())

  it('states today, and the rule, and carries each stored date', async () => {
    route([`EMAIL2:\n${CLEAN_2}\nEMAIL3:\n${CLEAN_3}`])
    await writeFollowups({
      apiKey: 'test', clientName: 'Example Co', buyer: 'an operator',
      email1Body: '{{first_name}},\n\nOne.\n\nTwo.\n\nThree?\n\n' + SIGNOFF,
      offerLine: 'A separate track keeps the conversations arriving.',
      // The findings block as produce-opening builds it, with the date line.
      findings: '1. They took on a second unit in March.\n   date: 2025-03-04\n   source: web | a page',
      findingsEvidence: '1. They took on a second unit in March.\n   source: web | a page',
      reference: REFERENCE, prospectId: 'dates-test', prospectFirstName: null,
      datedCandidates: [{ date: '2025-03-04', observation: 'They took on a second unit in March.' }],
      now: new Date('2026-09-25T00:00:00Z'),
    })
    const writerCall = createMock.mock.calls.find(c => {
      const sys = Array.isArray(c[0]?.system) ? c[0].system.map((b: { text?: string }) => b.text ?? '').join('') : String(c[0]?.system ?? '')
      return !sys.includes('You check whether an email')
    })!
    const user = String(writerCall[0].messages[0].content)
    const system = Array.isArray(writerCall[0].system)
      ? (writerCall[0].system as Array<{ text?: string }>).map(b => b.text ?? '').join('')
      : String(writerCall[0].system)

    expect(user).toContain('Today is 2026-09-25')
    expect(user).toContain('date: 2025-03-04')
    expect(system).toContain('NAME THE YEAR OF ANY EVENT THAT IS NOT FROM THIS YEAR')
    // POSITIVE CONTROL ON THE RULE'S OTHER HALF: a current-year event needs no year, or the
    // instruction would push a year onto every sentence and cost words for nothing.
    expect(system).toContain('An event from the CURRENT year needs no year')
  })
})
