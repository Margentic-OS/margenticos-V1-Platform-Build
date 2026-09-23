// POSITIVE CONTROL, BOTH DIRECTIONS, for the one-sentence observation slot.
//
// Same discipline as the sentence-length cap: every assertion is a PAIR built by the same
// helper, differing only in the slot paragraph, run through the REAL validateEmails rather
// than a copy of the rule. A gate that rejects everything and a gate that rejects nothing
// both look like a working gate from one side.

import { describe, it, expect } from 'vitest'
import { validateEmails, EMAIL_WORD_LIMITS, type EmailRecord } from '../messaging-generation-agent'
import { splitSentences } from '@/lib/style/readability'

const SENDER = 'Doug'
const COMPANY = 'MargenticOS'

const ONE_SENTENCE  = 'Work turns up when it turns up, not when the week needs it.'
// The same observation with a bridge welded on. This is the real shape: the second
// sentence names the consequence, which is the research writer's separate paragraph.
const TWO_SENTENCES = `${ONE_SENTENCE} When one goes quiet, nothing else is running to catch it.`

/** A structurally valid Email 1 whose slot paragraph is exactly `slot`. */
function email1WithSlot(slot: string): EmailRecord {
  const body = [
    '{{first_name}}',
    '',
    slot,
    '',
    'Work builds ahead of the gap instead of after it. New calls keep coming in while the team ships. Calls land in the week without the boss chasing a single name. The week fills up on time.',
    '',
    'Worth a look?',
    '',
    SENDER,
    COMPANY,
  ].join('\n')
  return {
    sequence_position: 1,
    subject_line: 'quick question',
    subject_char_count: 'quick question'.length,
    body,
    word_count: body.trim().split(/\s+/).filter(Boolean).length,
  }
}

/** The same paragraph placed in Email 2, where there is no slot and the gate must not fire. */
function emailAtPosition(pos: number, slot: string): EmailRecord {
  const body = [
    '{{first_name}}',
    '',
    slot,
    '',
    'Pipeline builds ahead of the gap instead of after it.',
    '',
    'Worth a look?',
    '',
    SENDER,
    COMPANY,
  ].join('\n')
  return {
    sequence_position: pos,
    subject_line: null,
    subject_char_count: 0,
    body,
    word_count: body.trim().split(/\s+/).filter(Boolean).length,
  }
}

const slotIssues = (slot: string) =>
  validateEmails([email1WithSlot(slot)], SENDER, COMPANY)
    .filter(v => v.issue.includes('must be ONE sentence'))
    .map(v => v.issue)

describe('the fixture is honest', () => {
  it('the two bodies differ in exactly one line', () => {
    const a = email1WithSlot(ONE_SENTENCE).body.split('\n')
    const b = email1WithSlot(TWO_SENTENCES).body.split('\n')
    expect(a.length).toBe(b.length)
    expect(a.map((l, i) => (l === b[i] ? null : i)).filter(i => i !== null)).toEqual([2])
  })

  it('the fixtures really are one and two sentences by the shared splitter', () => {
    expect(splitSentences(ONE_SENTENCE)).toHaveLength(1)
    expect(splitSentences(TWO_SENTENCES)).toHaveLength(2)
  })

  it.each([ONE_SENTENCE, TWO_SENTENCES])('both members of the pair sit inside the Email 1 word band', slot => {
    const wc = email1WithSlot(slot).word_count
    expect(wc).toBeGreaterThanOrEqual(EMAIL_WORD_LIMITS.email1MinWords)
    expect(wc).toBeLessThanOrEqual(EMAIL_WORD_LIMITS.email1MaxWords)
  })
})

describe('the failing direction', () => {
  it('rejects a two-sentence slot', () => {
    expect(slotIssues(TWO_SENTENCES)).toHaveLength(1)
  })

  it('says how many sentences it found and quotes the one to keep', () => {
    const issue = slotIssues(TWO_SENTENCES)[0]
    expect(issue).toContain("observation paragraph must be ONE sentence. It has 2")
    expect(issue).toContain(ONE_SENTENCE)
  })

  it('rejects three sentences too, so the gate is not an off-by-one on two', () => {
    expect(slotIssues(`${TWO_SENTENCES} The gap widens every quarter.`)).toHaveLength(1)
  })
})

describe('the passing direction', () => {
  it('accepts a one-sentence slot', () => {
    expect(slotIssues(ONE_SENTENCE)).toEqual([])
  })

  // The whole email must survive, not just this gate. A one-sentence slot that passes here
  // and fails four other checks would make the pair meaningless.
  it('the one-sentence email passes the WHOLE validator clean', () => {
    expect(validateEmails([email1WithSlot(ONE_SENTENCE)], SENDER, COMPANY)).toEqual([])
  })
})

// The slot exists only in Email 1. applyTriggerToEmail1 touches nothing else, so a
// multi-sentence opening paragraph in a follow-up is ordinary prose and gating it would
// reject good copy for a reason that does not apply.
describe('emails 2, 3 and 4 have no slot and are never gated on this', () => {
  it.each([2, 3, 4])('does not fire on email %i', pos => {
    const issues = validateEmails([emailAtPosition(pos, TWO_SENTENCES)], SENDER, COMPANY)
      .filter(v => v.issue.includes('must be ONE sentence'))
    expect(issues).toEqual([])
  })
})

// The gate must read the SAME paragraph composition replaces. If it ever protects a
// different one, it is worse than no gate.
describe('the gate reads the paragraph composition replaces', () => {
  it('ignores the {{first_name}} greeting when locating the slot', () => {
    // The greeting is its own paragraph. If it were counted, paragraph 0 would be the
    // greeting, the gate would measure the wrong text, and a two-sentence slot would pass.
    expect(slotIssues(TWO_SENTENCES)).toHaveLength(1)
    expect(slotIssues(ONE_SENTENCE)).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE BACK-REFERENCE EXEMPTION COVERS THE WHOLE SLOT.
//
// Added because mutation-testing found this uncovered: forcing findBackReferences back to
// exempting one paragraph left the entire suite green, so nothing was protecting the
// change. The consequence paragraph refers back to the observation by design, because the
// two are replaced together and always ship together. A gate that rejects it would make
// the two-paragraph slot unwritable, which is exactly the trap the one-sentence rule fell
// into before the word floor moved.
const SLOT_OBSERVATION = 'Most new work still turns up through a handful of old contacts.'
const SLOT_CONSEQUENCE = 'When those relationships go quiet, nothing else is running to catch the gap.'

function email1WithTwoParagraphSlot(consequence: string): EmailRecord {
  const body = [
    '{{first_name}}',
    '',
    SLOT_OBSERVATION,
    '',
    consequence,
    '',
    'Work builds ahead of the gap instead of after it. Calls keep coming in while the team ships.',
    '',
    'Worth a look?',
    '',
    SENDER,
    COMPANY,
  ].join('\n')
  return {
    sequence_position: 1,
    subject_line: 'quick question',
    subject_char_count: 'quick question'.length,
    body,
    word_count: body.trim().split(/\s+/).filter(Boolean).length,
  }
}

describe('a two-paragraph slot whose consequence points back at its own observation', () => {
  it('the fixture really does contain a demonstrative binding a noun', () => {
    expect(SLOT_CONSEQUENCE).toContain('those relationships')
  })

  it('sits inside the Email 1 word band, so the band is not what is being measured', () => {
    const wc = email1WithTwoParagraphSlot(SLOT_CONSEQUENCE).word_count
    expect(wc).toBeGreaterThanOrEqual(EMAIL_WORD_LIMITS.email1MinWords)
    expect(wc).toBeLessThanOrEqual(EMAIL_WORD_LIMITS.email1MaxWords)
  })

  it('is NOT rejected for the back-reference', () => {
    const issues = validateEmails([email1WithTwoParagraphSlot(SLOT_CONSEQUENCE)], SENDER, COMPANY)
    expect(issues.filter(v => v.issue.includes('back-reference'))).toEqual([])
  })

  it('passes the WHOLE validator clean', () => {
    expect(validateEmails([email1WithTwoParagraphSlot(SLOT_CONSEQUENCE)], SENDER, COMPANY)).toEqual([])
  })

  // The exemption must not become "never check anything". A paragraph AFTER the slot that
  // points back at the slot is still rejected, because the slot it points at is replaced.
  it('still rejects a back-reference in the offer line, which is outside the slot', () => {
    const body = [
      '{{first_name}}', '', SLOT_OBSERVATION, '', SLOT_CONSEQUENCE, '',
      'We break that ceiling by running outbound continuously for you every single week.',
      '', 'Worth a look?', '', SENDER, COMPANY,
    ].join('\n')
    const email: EmailRecord = {
      sequence_position: 1, subject_line: 'quick question', subject_char_count: 14,
      body, word_count: body.trim().split(/\s+/).filter(Boolean).length,
    }
    const issues = validateEmails([email], SENDER, COMPANY)
    expect(issues.some(v => v.issue.includes('back-reference'))).toBe(true)
  })
})
