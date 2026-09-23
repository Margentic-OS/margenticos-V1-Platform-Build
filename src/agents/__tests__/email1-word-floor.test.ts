// POSITIVE CONTROL, BOTH DIRECTIONS, for lowering Email 1's word floor from 50 to 40.
//
// The floor's whole job is to reject a thin email, so a change to it has to be shown
// working in BOTH directions or it is indistinguishable from deleting the floor. The
// third case is the one that motivated the change: a 46-word email that the old floor
// rejected, which is complete and legal and now passes everything.

import { describe, it, expect } from 'vitest'
import { validateEmails, EMAIL_WORD_LIMITS, type EmailRecord } from '../messaging-generation-agent'

const SENDER = 'Doug'
const COMPANY = 'MargenticOS'

// Ordinary words: no firmographics, no jargon, no banned AI words, no demonstratives
// binding a noun, no ampersands.
const FILLER = 'work slows down when the boss runs every call with help'.split(' ')

/** A sentence of exactly `n` words, under the 25-word cap at every size used here. */
function sentenceOf(n: number): string {
  const w: string[] = []
  while (w.length < n) w.push(FILLER[w.length % FILLER.length])
  w[0] = w[0][0].toUpperCase() + w[0].slice(1)
  return w.join(' ') + '.'
}

/**
 * A structurally valid Email 1 of exactly `total` words, in the real frame: a ONE-SENTENCE
 * observation slot, an offer paragraph, a CTA question, and the two-line sign-off.
 *
 * Word budget: 1 greeting + slot + offer + 3 CTA + 2 sign-off. The slot is held at 18
 * words, which is a realistic one-sentence observation, and the offer paragraph absorbs
 * the remainder, so only ONE number varies with `total`.
 */
function email1Of(total: number): EmailRecord {
  const SLOT_WORDS = 18
  const offerWords = total - 1 - SLOT_WORDS - 3 - 2
  const offerSentences: string[] = []
  let left = offerWords
  while (left > 0) {
    const take = Math.min(left, 14)   // keeps every sentence far under the 25-word cap
    offerSentences.push(sentenceOf(take))
    left -= take
  }
  const body = [
    '{{first_name}}',
    '',
    sentenceOf(SLOT_WORDS),
    '',
    offerSentences.join(' '),
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

const wordCountIssues = (total: number) =>
  validateEmails([email1Of(total)], SENDER, COMPANY)
    .filter(v => v.issue.includes('word count'))
    .map(v => v.issue)

describe('the fixture is honest', () => {
  it.each([39, 41, 46, 50])('builds an email of exactly %i words', n => {
    expect(email1Of(n).word_count).toBe(n)
  })

  it('the slot really is one sentence, so the slot rule is not what is being measured', () => {
    const slot = email1Of(46).body.split(/\n{2,}/)[1]
    expect(slot.trim().split('.').filter(s => s.trim()).length).toBe(1)
  })
})

describe('the constant moved, and only Email 1 moved', () => {
  it('Email 1 floor is 40', () => {
    expect(EMAIL_WORD_LIMITS.email1MinWords).toBe(40)
  })

  // The floor is per position. If Email 1 ever came to share a constant with another
  // position, lowering it here would quietly lower it there.
  it('no other position shares the Email 1 floor', () => {
    expect(EMAIL_WORD_LIMITS.email2MinWords).toBe(30)
    expect(EMAIL_WORD_LIMITS.email3MinWords).toBe(30)
    expect(EMAIL_WORD_LIMITS.email4MinWords).toBe(0)
  })

  it('the ceiling did not move with the floor', () => {
    expect(EMAIL_WORD_LIMITS.email1MaxWords).toBe(90)
    expect(EMAIL_WORD_LIMITS.email1TargetMaxWords).toBe(80)
  })
})

describe('the failing direction — the floor still rejects a thin email', () => {
  it('rejects 39 words', () => {
    expect(wordCountIssues(39)).toHaveLength(1)
  })

  it('names the new band, so a retry is a correction', () => {
    expect(wordCountIssues(39)[0]).toContain('word count 39 is outside the 40 to 90 word range')
  })

  it('still rejects something clearly thin', () => {
    expect(wordCountIssues(30)).toHaveLength(1)
  })
})

describe('the passing direction', () => {
  it('accepts 41 words', () => {
    expect(wordCountIssues(41)).toEqual([])
  })

  it('accepts exactly 40, the boundary', () => {
    expect(wordCountIssues(40)).toEqual([])
  })
})

// THE CASE THAT MOTIVATED THE CHANGE. On 2026-09-18 the agent produced Email 1s of 46 and
// 41 words under the one-sentence slot rule. Both were complete and legal and were
// rejected on length alone, and the run burned all seven calls without writing anything.
describe('the 46-word email the old floor rejected', () => {
  it('failed the old floor of 50', () => {
    expect(email1Of(46).word_count).toBeLessThan(50)
  })

  it('now passes the WHOLE validator clean, not just the word gate', () => {
    expect(validateEmails([email1Of(46)], SENDER, COMPANY)).toEqual([])
  })

  it('so does the 41-word one', () => {
    expect(validateEmails([email1Of(41)], SENDER, COMPANY)).toEqual([])
  })
})
