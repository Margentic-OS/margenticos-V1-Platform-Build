// Gate tests for the relaxations and the new firmographic ban.
//
// Anchors are the real rejections from the last generation: variant A was rejected at 26
// and 29 words on Email 4, variants were rejected for an Email 2 no shorter than Email 1,
// and two variants shipped the client's revenue band in the opening line.

import { describe, it, expect } from 'vitest'
import { validateEmails, EMAIL_WORD_LIMITS, type EmailRecord } from '../messaging-generation-agent'

const SENDER = 'Doug'
const COMPANY = 'MargenticOS'

function email(pos: number, body: string, subject: string | null = null): EmailRecord {
  return {
    sequence_position: pos,
    subject_line: subject,
    subject_char_count: subject ? subject.length : 0,
    body,
    word_count: body.trim().split(/\s+/).filter(Boolean).length,
  }
}

// Builds a body of roughly `words` words that satisfies the structural rules.
function bodyOf(words: number): string {
  const base = 'Most founders at your stage see the same thing happen again'.split(' ')
  const need = Math.max(1, words - 3)   // greeting plus the two sign-off lines
  const filler: string[] = []
  while (filler.length < need) filler.push(base[filler.length % base.length])
  return `{{first_name}}\n\n${filler.join(' ')}.\n\n${SENDER}\n${COMPANY}`
}

function issuesFor(emails: EmailRecord[], pos: number): string[] {
  return validateEmails(emails, SENDER, COMPANY).filter(v => v.email === pos).map(v => v.issue)
}

describe('Email 4 has no word floor', () => {
  it('exposes a zero minimum', () => {
    expect(EMAIL_WORD_LIMITS.email4MinWords).toBe(0)
  })

  it.each([26, 29])('accepts a %i-word breakup, which used to be rejected', n => {
    const emails = [email(1, bodyOf(70)), email(2, bodyOf(60)), email(3, bodyOf(50)), email(4, bodyOf(n))]
    expect(issuesFor(emails, 4).filter(i => i.includes('word count'))).toEqual([])
  })

  it('still enforces the 50-word ceiling', () => {
    const emails = [email(1, bodyOf(70)), email(2, bodyOf(60)), email(3, bodyOf(50)), email(4, bodyOf(60))]
    expect(issuesFor(emails, 4).some(i => i.includes('word count'))).toBe(true)
  })
})

describe('the descending rule allows equal lengths', () => {
  it('accepts Email 2 exactly equal to Email 1', () => {
    const emails = [email(1, bodyOf(60)), email(2, bodyOf(60)), email(3, bodyOf(50)), email(4, bodyOf(40))]
    expect(issuesFor(emails, 2).some(i => i.includes('longer than'))).toBe(false)
  })

  it('accepts Email 3 exactly equal to Email 2', () => {
    const emails = [email(1, bodyOf(60)), email(2, bodyOf(55)), email(3, bodyOf(55)), email(4, bodyOf(40))]
    expect(issuesFor(emails, 3).some(i => i.includes('longer than'))).toBe(false)
  })

  it('still rejects Email 2 longer than Email 1', () => {
    const emails = [email(1, bodyOf(55)), email(2, bodyOf(65)), email(3, bodyOf(50)), email(4, bodyOf(40))]
    expect(issuesFor(emails, 2).some(i => i.includes('longer than email 1'))).toBe(true)
  })
})

describe('firmographic figures are banned', () => {
  const wrap = (sentence: string) =>
    `{{first_name}}\n\n${sentence}\n\nWe run the outbound for you.\n\nIs that where you are?\n\n${SENDER}\n${COMPANY}`

  it.each([
    'Most B2B consulting firms at the £500K to £5M mark close well when conversations happen.',
    'For most consulting founders billing north of £500K, the week is consumed by delivery.',
    'Most B2B consulting firms at the 500K to 5M mark close well when conversations happen.',
    'Firms with 12 employees usually hit this wall at some point in the year.',
    'A team of 14 rarely has anyone spare to run the prospecting side of things.',
  ])('rejects %s', sentence => {
    const emails = [email(1, wrap(sentence), 'a subject'), email(2, bodyOf(60)), email(3, bodyOf(50)), email(4, bodyOf(40))]
    expect(issuesFor(emails, 1).some(i => i.includes('firmographic'))).toBe(true)
  })

  it.each([
    'Read through your last 30 reviews on Google and count the hold time complaints.',
    'Front desk hold times keep coming up, 4 of the most recent 10 mention it.',
    'You ran the firm and the Director role side by side for 13 months last year.',
    'One warm intro every six or eight weeks keeps things moving along nicely.',
  ])('leaves ordinary numbers alone: %s', sentence => {
    const emails = [email(1, wrap(sentence), 'a subject'), email(2, bodyOf(60)), email(3, bodyOf(50)), email(4, bodyOf(40))]
    expect(issuesFor(emails, 1).some(i => i.includes('firmographic'))).toBe(false)
  })
})
