// Gate tests for the relaxations and the new firmographic ban.
//
// Anchors are the real rejections from the last generation: variant A was rejected at 26
// and 29 words on Email 4, variants were rejected for an Email 2 no shorter than Email 1,
// and two variants shipped the client's revenue band in the opening line.

import { describe, it, expect } from 'vitest'
import { validateEmails, EMAIL_WORD_LIMITS, type EmailRecord } from '../messaging-generation-agent'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findFirmographicFigures } from '@/lib/style/firmographic'

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

  // REVERSED 2026-08-28, deliberately. This used to assert that Email 2 longer than
  // Email 1 was rejected. That coupling asked the model to hit a target it cannot see:
  // all four emails are written in one response, so Email 1's final word count does not
  // exist while Email 2 is being written. Measured across 15 attempts in two runs, it
  // caused eight failed single-variant API calls in one run and exhausted the 240s guard.
  it('accepts Email 2 longer than Email 1', () => {
    const emails = [email(1, bodyOf(55)), email(2, bodyOf(65)), email(3, bodyOf(50)), email(4, bodyOf(40))]
    expect(issuesFor(emails, 2).some(i => i.includes('longer than'))).toBe(false)
  })

  it('accepts the exact shape that failed in production: Email 2 at 74, Email 1 at 62', () => {
    const emails = [email(1, bodyOf(62)), email(2, bodyOf(74)), email(3, bodyOf(50)), email(4, bodyOf(40))]
    expect(issuesFor(emails, 2)).toEqual([])
  })

  // Email 3 keeps its coupling to Email 2. Same shape, kept on purpose and logged in
  // BACKLOG; it binds far less often now Email 2 may run to 85.
  it('still rejects Email 3 longer than Email 2', () => {
    const emails = [email(1, bodyOf(70)), email(2, bodyOf(50)), email(3, bodyOf(60)), email(4, bodyOf(40))]
    expect(issuesFor(emails, 3).some(i => i.includes('longer than email 2'))).toBe(true)
  })
})

describe('the Email 2 band', () => {
  it('is 30 to 85', () => {
    expect(EMAIL_WORD_LIMITS.email2MinWords).toBe(30)
    expect(EMAIL_WORD_LIMITS.email2MaxWords).toBe(85)
  })

  it('covers every Email 2 length measured in the two failed runs on 2026-08-28', () => {
    // The full observed set, first-pass and retry attempts across both runs.
    const observed = [62, 68, 68, 69, 70, 71, 72, 74, 74, 74, 75, 75, 76, 77, 79]
    for (const wc of observed) {
      const emails = [email(1, bodyOf(60)), email(2, bodyOf(wc)), email(3, bodyOf(50)), email(4, bodyOf(40))]
      expect({ wc, issues: issuesFor(emails, 2) }).toEqual({ wc, issues: [] })
    }
  })

  it('still rejects 86 and 29', () => {
    const over = [email(1, bodyOf(60)), email(2, bodyOf(86)), email(3, bodyOf(50)), email(4, bodyOf(40))]
    expect(issuesFor(over, 2).some(i => i.includes('word count'))).toBe(true)
    const under = [email(1, bodyOf(60)), email(2, bodyOf(29)), email(3, bodyOf(25)), email(4, bodyOf(20))]
    expect(issuesFor(under, 2).some(i => i.includes('word count'))).toBe(true)
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

// ─── Subject parity ───────────────────────────────────────────────────────────
//
// Both bans were written as test(body) and the subject was checked for length and
// null-ness only, so a revenue band in the one line every recipient reads passed a
// validator that already owned every pattern needed to catch it. The prompt made this
// worse rather than better: its example-subject-lines block offered
// "£500k revenue question" as a model to copy.
//
// The tests below are paired on purpose. Asserting only that a bad subject is rejected
// would still pass if the check were bolted onto the wrong surface, so each case asserts
// the CLEAN counterpart is untouched.
describe('the subject line is scanned like the body', () => {
  const CLEAN_BODY = `{{first_name}}\n\nMost of the people we speak to find new work arrives through introductions they cannot plan around.\n\nWe run the outbound so the meetings land without you writing anything.\n\nIs that where you are right now?\n\n${SENDER}\n${COMPANY}`

  const subjectIssues = (subject: string | null) => {
    const emails = [email(1, CLEAN_BODY, subject), email(2, bodyOf(60)), email(3, bodyOf(50)), email(4, bodyOf(40))]
    return issuesFor(emails, 1).filter(i => i.startsWith('subject line'))
  }

  it.each([
    ['£500k revenue question', 'firmographic'],
    ['5M pipeline question', 'firmographic'],
    ['team of 12 problem', 'firmographic'],
    ['12 employees, one gap', 'firmographic'],
    ['your ICP is drifting', 'jargon'],
    ['the go-to-market gap', 'jargon'],
  ])('rejects %s', (subject, kind) => {
    expect(subjectIssues(subject).some(i => i.includes(kind))).toBe(true)
  })

  it.each([
    'pipeline after referrals',
    'the timing question',
    'saw your post on pricing',
    'q4 pipeline',
    'cold food complaints',
    'the flask comes back',
  ])('leaves the clean subject alone: %s', subject => {
    expect(subjectIssues(subject)).toEqual([])
  })

  // The body path must not have been traded away for the subject path.
  it('still rejects the same figure in the body', () => {
    const body = CLEAN_BODY.replace('introductions they cannot plan around', 'introductions, at the £500K mark')
    const emails = [email(1, body, 'pipeline after referrals'), email(2, bodyOf(60)), email(3, bodyOf(50)), email(4, bodyOf(40))]
    expect(issuesFor(emails, 1).some(i => i.startsWith('body quotes'))).toBe(true)
  })

  // A null subject is the required state for emails 2 to 4 and must not be read as ''.
  it('does not invent a violation for the null subjects on emails 2 to 4', () => {
    const emails = [email(1, CLEAN_BODY, 'pipeline after referrals'), email(2, bodyOf(60)), email(3, bodyOf(50)), email(4, bodyOf(40))]
    for (const pos of [2, 3, 4]) {
      expect(issuesFor(emails, pos).filter(i => i.startsWith('subject line'))).toEqual([])
    }
  })

  // MUTATION GUARD. The defect was two blocks that both said `body`. Reverting either
  // surface must fail here, so the pair is asserted rather than the union.
  it('scans both surfaces, not one of them', () => {
    expect(subjectIssues('£500k revenue question').length).toBeGreaterThan(0)
    const dirtyBody = CLEAN_BODY.replace('introductions they cannot plan around', 'introductions, at the £500K mark')
    const emails = [email(1, dirtyBody, 'pipeline after referrals'), email(2, bodyOf(60)), email(3, bodyOf(50)), email(4, bodyOf(40))]
    expect(issuesFor(emails, 1).filter(i => i.startsWith('body quotes')).length).toBeGreaterThan(0)
  })
})

// ─── The prompt's own specimens ───────────────────────────────────────────────
//
// A prompt that shows the model a passage the validator rejects buys a regeneration call
// against MAX_ANTHROPIC_CALLS every time the model does as it was told. That is not
// theoretical: the exemplar passage at docs/prompts/messaging-agent.md was copied verbatim
// into a live active messaging document, where it hard-failed.
//
// This reads the prompt file rather than a copy of it, so the two cannot drift.
describe('every specimen the prompt offers as a model passes the validator', () => {
  const md = readFileSync(join(process.cwd(), 'docs/prompts/messaging-agent.md'), 'utf-8')

  // Deliberately NOT scanned: the block labelled FAILING, which exists to show what a
  // rejection looks like and is correct as it stands.
  const FAILING_MARKER = 'FAILING, both shipped in the same generation:'

  it('found the prompt file, so nothing below passes vacuously', () => {
    expect(md.length).toBeGreaterThan(1000)
    expect(md).toContain(FAILING_MARKER)
  })

  it.each([
    ['the peer-pattern exemplar passage', 'Most of the people I speak to who still price every job themselves'],
    ['the Rule 6 "Right" specimen', 'It is the only approach that still runs in a month when nobody has time'],
  ])('%s is present and clean', (_label, fragment) => {
    expect(md).toContain(fragment)
    expect(findFirmographicFigures(fragment)).toEqual([])
  })

  it('the example subject lines carry no figure, currency or headcount', () => {
    // Anchored on the caption WITHOUT its leading count. The caption used to read "Ten
    // example subject lines:" over a list of nine, and the count was removed rather than
    // corrected so it cannot drift again. A literal anchor here would have to be edited
    // every time that happens, and the vacuity guard below is the only reason the last
    // edit did not silently empty this block instead of failing.
    const block = md.split(/^(?:\w+ )?example subject lines:/im)[1]?.split('---')[0] ?? ''
    expect(block.length).toBeGreaterThan(20)
    for (const subject of block.split('/').map(s => s.trim()).filter(Boolean)) {
      expect(findFirmographicFigures(subject)).toEqual([])
    }
  })

  it('the FAILING block is left intact, because it is working correctly', () => {
    const failing = md.split(FAILING_MARKER)[1]?.slice(0, 200) ?? ''
    expect(findFirmographicFigures(failing).length).toBeGreaterThan(0)
  })
})
