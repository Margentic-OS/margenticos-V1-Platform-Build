// POSITIVE CONTROL, BOTH DIRECTIONS, for the sentence-length cap in validateEmails.
//
// A gate that rejects everything is an outage and a gate that rejects nothing is
// decoration, and neither is distinguishable from a working gate by watching it fail. So
// every assertion here comes in a pair: the same email, built by the same helper, once at
// 30 words in a sentence and once at 20, and the ONLY thing that differs between them is
// the length of that one sentence.
//
// Run through the REAL validateEmails, not a copy of the rule. A test that reimplements
// the check proves the test can count, which is not the question.

import { describe, it, expect } from 'vitest'
import {
  validateEmails,
  emailProse,
  EMAIL_WORD_LIMITS,
  EMAIL_SENTENCE_WORD_CAP,
  type EmailRecord,
} from '../messaging-generation-agent'
import { MAX_SENTENCE_WORDS, splitSentences } from '@/lib/style/readability'

const SENDER = 'Doug'
const COMPANY = 'MargenticOS'

// Words that trip nothing else in the validator: no firmographic figures, no jargon, no
// banned AI words, no ampersands, no demonstratives binding a noun. Also deliberately
// PLAIN: the reading-grade gate rejects an email over grade 5, so a filler carrying
// "pipeline", "founder" and "conversation" would fail this fixture on vocabulary and
// break the pair below for a reason that has nothing to do with sentence length.
const FILLER = 'work slows down when the boss runs every call with no help'.split(' ')

/** One sentence of exactly `n` words, ending in a full stop. */
function sentenceOf(n: number): string {
  const words: string[] = []
  while (words.length < n) words.push(FILLER[words.length % FILLER.length])
  words[0] = words[0][0].toUpperCase() + words[0].slice(1)
  return words.join(' ') + '.'
}

/**
 * A structurally valid Email 1 whose observation paragraph is one sentence of `n` words.
 * Everything else is held constant, so a change in the verdict can only come from `n`.
 */
function emailWithSentence(n: number, pos: number = 2): EmailRecord {
  const body = [
    '{{first_name}}',
    '',
    sentenceOf(n),
    '',
    // ONE offer paragraph. Two would make this a five-paragraph document, and the second
    // would be read as the slot's consequence and gated for being one sentence.
    'Work builds ahead of the gap instead of after it. Nothing runs in the back while the team ships. New calls turn up before the gap, not after it.',
    '',
    'Worth a look?',
    '',
    SENDER,
    COMPANY,
  ].join('\n')
  return {
    sequence_position: pos,
    // Only Email 1 carries a subject. Emails 2 to 4 thread under it and must be null.
    subject_line: pos === 1 ? 'quick question' : null,
    subject_char_count: pos === 1 ? 'quick question'.length : 0,
    body,
    word_count: body.trim().split(/\s+/).filter(Boolean).length,
  }
}

function capIssues(n: number, pos: number = 2): string[] {
  const e = emailWithSentence(n, pos)
  return validateEmails([e], SENDER, COMPANY)
    .filter(v => v.issue.includes('cap is'))
    .map(v => v.issue)
}

describe('the fixture itself is honest', () => {
  it('builds a sentence of exactly the requested length', () => {
    expect(sentenceOf(30).trim().split(/\s+/)).toHaveLength(30)
    expect(sentenceOf(20).trim().split(/\s+/)).toHaveLength(20)
  })

  it('the 30 and 20 word emails differ ONLY in that sentence', () => {
    const a = emailWithSentence(30).body.split('\n')
    const b = emailWithSentence(20).body.split('\n')
    expect(a.length).toBe(b.length)
    const differing = a.map((l, i) => (l === b[i] ? null : i)).filter(i => i !== null)
    expect(differing).toEqual([2])
  })

  // Both members of the pair must sit inside Email 1's word band. Read from the constant,
  // never restated: this assertion said 50 until the floor moved to 40 on 2026-09-19, and a
  // literal here is a second copy of a number that lives in one place.
  // If one fell outside it, the whole-validator assertion below would be measuring the
  // band rather than the cap, and the pair would prove nothing about sentence length.
  it.each([20, 30])('the %i-word variant sits inside the Email 2 word band', n => {
    const wc = emailWithSentence(n).word_count
    expect(wc).toBeGreaterThanOrEqual(EMAIL_WORD_LIMITS.email2MinWords)
    expect(wc).toBeLessThanOrEqual(EMAIL_WORD_LIMITS.email2MaxWords)
  })

  it('the research module constant is NOT what gates an email any more', () => {
    // MAX_SENTENCE_WORDS belongs to the research writer's observation and stays 25. The
    // messaging gate used to borrow it and now does not, so the two are asserted apart:
    // if someone re-points the email cap at it, this says so.
    expect(MAX_SENTENCE_WORDS).toBe(25)
    expect(EMAIL_SENTENCE_WORD_CAP).not.toBe(MAX_SENTENCE_WORDS)
  })
})

describe('sentence-length cap — the failing direction', () => {
  it('rejects a 30-word sentence', () => {
    expect(capIssues(30)).toHaveLength(1)
  })

  it('names the measured length and the cap, so a retry is a correction', () => {
    expect(capIssues(30)[0]).toContain(`sentence runs 30 words, cap is ${EMAIL_SENTENCE_WORD_CAP}`)
  })
})

describe('sentence-length cap — the passing direction', () => {
  it('accepts a 12-word sentence', () => {
    expect(capIssues(12)).toEqual([])
  })

  // The whole email must survive, not just the cap check. A sentence that passes the cap
  // and fails four other gates would make the pair above meaningless.
  it('the 12-word email passes the WHOLE validator clean', () => {
    expect(validateEmails([emailWithSentence(12)], SENDER, COMPANY)).toEqual([])
  })
})

// The greeting and sign-off lines carry no terminator, so leaving them in would attach
// them to real sentences and inflate the count. Measured across the 320 emails in every
// messaging document in production: scanning the raw body fails 72 emails against 60 for
// the prose, so 12 of those 72 failures would have been the {{first_name}} line.
describe('the scanned surface excludes the merge tag and the sign-off', () => {
  it('drops the greeting and both sign-off lines, and keeps the prose', () => {
    const prose = emailProse(emailWithSentence(12).body, SENDER, COMPANY)
    expect(prose).not.toContain('{{first_name}}')
    expect(prose.split('\n').map(l => l.trim())).not.toContain(SENDER)
    expect(prose.split('\n').map(l => l.trim())).not.toContain(COMPANY)
    expect(prose).toContain('Work builds ahead of the gap')
  })

  it('a sentence at exactly the cap would fail if the greeting were left attached', () => {
    const body = emailWithSentence(EMAIL_SENTENCE_WORD_CAP).body
    const rawFirst = splitSentences(body)[0]
    expect(rawFirst.trim().split(/\s+/).length).toBe(EMAIL_SENTENCE_WORD_CAP + 1)
    // ...and it passes, because the gate scans the prose rather than the raw body.
    expect(capIssues(EMAIL_SENTENCE_WORD_CAP)).toEqual([])
  })
})

// ─── THE CAP IS 15 IN EVERY EMAIL ────────────────────────────────────────────
//
// POSITIVE CONTROL, BOTH DIRECTIONS, AT EVERY POSITION. The cap was per-position for two
// days: 12 then 15 for Email 1, 25 for the rest. It is now one number for all four, so the
// control that matters is no longer a pair across positions but the SAME boundary holding
// at each of them. A cap that quietly stopped applying to emails 2 to 4 is exactly the
// regression this file exists to catch, and it would be invisible from Email 1 alone.
describe('the sentence cap is 15 and applies to every email', () => {
  it('the cap under test is the constant, not a local number', () => {
    expect(EMAIL_SENTENCE_WORD_CAP).toBe(15)
  })

  it.each([1, 2, 3, 4])('rejects a 16-word sentence in email %i', pos => {
    expect(capIssues(EMAIL_SENTENCE_WORD_CAP + 1, pos)).toHaveLength(1)
  })

  it.each([1, 2, 3, 4])('accepts exactly 15 words in email %i', pos => {
    expect(capIssues(EMAIL_SENTENCE_WORD_CAP, pos)).toEqual([])
  })

  it('rejects a 20-word sentence at EVERY position, not just Email 1', () => {
    // The old behaviour passed this in emails 2 to 4. Pinning all four positions is what
    // makes the change to emails 2 to 4 a tested fact rather than a claim.
    for (const pos of [1, 2, 3, 4]) expect(capIssues(20, pos)).toHaveLength(1)
  })

  it('names the cap and says it applies everywhere, so a retry is a correction', () => {
    const issue = capIssues(20, 2)[0]
    expect(issue).toContain(`sentence runs 20 words, cap is ${EMAIL_SENTENCE_WORD_CAP}`)
    expect(issue).toContain('in every email')
  })
})
