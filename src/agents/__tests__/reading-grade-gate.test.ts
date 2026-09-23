// POSITIVE CONTROL, BOTH DIRECTIONS, for the reading-grade gate in validateEmails.
//
// A gate that rejects everything is an outage and a gate that rejects nothing is
// decoration, and neither is distinguishable from a working gate by watching it fail. So
// the central pair here is two emails that differ by EXACTLY ONE WORD, "hard" against
// "difficult", with the same 37 words and the same 5 sentences. One scores 4.84 and
// passes, the other 5.47 and fails. Nothing else about them differs, so the verdict can
// only have come from the vocabulary.
//
// Run through the REAL validateEmails, not a copy of the rule. A test that reimplements
// the check proves the test can do arithmetic, which is not the question.
//
// MUTATION-PROVED. Each of the three guards here was deleted in turn and a test went red:
//   remove the `reading.grade > MAX_READING_GRADE` push  -> "the gate fires" fails
//   score emailProse instead of authoredProse            -> "a held CTA is excluded" fails
//   drop the held-paragraph filter in authoredProse      -> "a held CTA is excluded" fails
// The full run is recorded in the commit message.

import { describe, it, expect } from 'vitest'
import { validateEmails, authoredProse, type EmailRecord } from '../messaging-generation-agent'
import { fleschKincaidGrade, MAX_READING_GRADE } from '@/lib/style/reading-grade'

const SENDER = 'Doug'
const COMPANY = 'MargenticOS'

// The held CTA. Grade -2.23 on its own, which is the point: in the live document these
// questions were the cleanest prose there was, and averaging them in was lifting whole
// emails over the line that their own bodies could not clear.
const CTA = 'Does that sound right?'

// ONE skeleton, TWO vocabularies. Same sentence count, same word count. The only
// difference between PLAIN and DENSE is the single word marked below.
const PLAIN_PARAGRAPHS = [
  'Most firms we speak to have the same difficulty. New business arrives through established relationships.',
  //                                                    vv this word is the whole experiment
  'When that source goes quiet, nothing else is operating. The variation makes it hard to plan or hire.',
]
const DENSE_PARAGRAPHS = [
  'Most firms we speak to have the same difficulty. New business arrives through established relationships.',
  'When that source goes quiet, nothing else is operating. The variation makes it difficult to plan or hire.',
]

/**
 * A structurally valid Email 2. Position 2 is used deliberately: it has no Email 1 frame
 * to satisfy, so the fixture can hold everything constant except the words under test,
 * and it is one of the two positions whose CTA was actually held on 2026-09-22.
 */
function emailOf(paragraphs: string[]): EmailRecord {
  const body = ['{{first_name}}', '', ...paragraphs.flatMap(p => [p, '']), CTA, '', SENDER, COMPANY].join('\n')
  return {
    sequence_position: 2,
    subject_line: null,
    subject_char_count: 0,
    body,
    word_count: body.trim().split(/\s+/).filter(Boolean).length,
  }
}

const gradeIssues = (email: EmailRecord, held: readonly string[] = []) =>
  validateEmails([email], SENDER, COMPANY, held)
    .filter(v => v.issue.includes('reading grade'))
    .map(v => v.issue)

describe('the fixture itself is honest', () => {
  it('PLAIN and DENSE differ by exactly one word', () => {
    const plain = PLAIN_PARAGRAPHS.join(' ').split(/\s+/)
    const dense = DENSE_PARAGRAPHS.join(' ').split(/\s+/)
    expect(plain).toHaveLength(dense.length)
    const differing = plain.filter((w, i) => w !== dense[i])
    expect(differing).toEqual(['hard'])
  })

  it('straddles the threshold, and the threshold is where the constant says', () => {
    // Pins the actual numbers. If the instrument drifts, this fails here with a readable
    // message rather than silently turning one of the gate tests into a tautology.
    const plain = fleschKincaidGrade(PLAIN_PARAGRAPHS.concat(CTA).join('\n\n'))!
    const dense = fleschKincaidGrade(DENSE_PARAGRAPHS.concat(CTA).join('\n\n'))!
    expect(plain.words).toBe(dense.words)
    expect(plain.sentences).toBe(dense.sentences)
    expect(plain.grade).toBeCloseTo(4.84, 1)
    expect(dense.grade).toBeCloseTo(5.47, 1)
    expect(plain.grade).toBeLessThanOrEqual(MAX_READING_GRADE)
    expect(dense.grade).toBeGreaterThan(MAX_READING_GRADE)
  })

  it('the passing fixture trips no other gate, so a clean result means something', () => {
    // Without this, "no reading-grade violation" could sit alongside five other failures
    // and the fixture would be proving nothing about the gate under test.
    expect(validateEmails([emailOf(PLAIN_PARAGRAPHS)], SENDER, COMPANY)).toEqual([])
  })
})

describe('the reading-grade gate, both directions', () => {
  it('FIRES on prose above the grade', () => {
    const issues = gradeIssues(emailOf(DENSE_PARAGRAPHS))
    expect(issues).toHaveLength(1)
    expect(issues[0]).toContain('5.5')
    expect(issues[0]).toContain(`maximum of ${MAX_READING_GRADE}`)
  })

  it('STAYS SILENT on the same prose one word plainer', () => {
    expect(gradeIssues(emailOf(PLAIN_PARAGRAPHS))).toEqual([])
  })
})

describe('a held paragraph cannot decide the verdict', () => {
  it('a held CTA is EXCLUDED, and that makes the gate stricter rather than softer', () => {
    // The same email, twice, differing only in whether the CTA was authored or supplied.
    // Counted: 4.84, passes. Held and therefore excluded: 5.86, fails.
    //
    // This is the direction that surprised us. Holding a paragraph was expected to protect
    // an email from a failure it could not fix; measured on the live document it was doing
    // the opposite, lending every email between +0.80 and +2.02 grades of credit for a
    // question the agent was not being asked to write.
    const email = emailOf(PLAIN_PARAGRAPHS)
    expect(gradeIssues(email)).toEqual([])
    const withHeld = gradeIssues(email, [CTA])
    expect(withHeld).toHaveLength(1)
    expect(withHeld[0]).toContain('5.9')
  })

  it('editing a held paragraph cannot buy a pass', () => {
    // The property that makes "spend no budget on held CTAs" true by construction rather
    // than by a rule someone has to remember. A held paragraph is matched by its text, so
    // an agent that CHANGES it no longer matches, and the changed text is scored like
    // anything else it wrote. There is no edit that removes scored words from the email.
    const edited = emailOf(PLAIN_PARAGRAPHS).body.replace(CTA, 'Does that characterisation correspond to your situation?')
    const email: EmailRecord = { ...emailOf(PLAIN_PARAGRAPHS), body: edited }
    const surface = authoredProse(email.body, SENDER, COMPANY, [CTA])
    expect(surface).toContain('characterisation')
  })

  it('holds nothing by default, so ordinary generation is unchanged', () => {
    // Both production callers pass three arguments. If the default ever became anything
    // other than "the agent wrote all of it", every existing generation would silently
    // start scoring a different surface.
    const body = emailOf(PLAIN_PARAGRAPHS).body
    expect(authoredProse(body, SENDER, COMPANY)).toBe(authoredProse(body, SENDER, COMPANY, []))
    expect(authoredProse(body, SENDER, COMPANY)).toContain(CTA)
  })

  it('matches a held paragraph despite whitespace differences', () => {
    const body = emailOf(PLAIN_PARAGRAPHS).body
    expect(authoredProse(body, SENDER, COMPANY, ['  Does that   sound right?  '])).not.toContain(CTA)
  })
})
