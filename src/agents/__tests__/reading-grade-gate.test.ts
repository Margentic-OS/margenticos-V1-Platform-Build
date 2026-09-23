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
import {
  validateEmails,
  authoredProse,
  buildHeldParagraphsBlock,
  EMAIL1_MAX_SENTENCE_WORDS,
  type EmailRecord,
  type HeldParagraph,
} from '../messaging-generation-agent'
import { fleschKincaidGrade, splitSentencesFk, MAX_READING_GRADE } from '@/lib/style/reading-grade'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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

describe('the prompt and the gate agree about what is held', () => {
  // THE SEAM, tested as a PAIR rather than as two sides. The prompt tells the agent which
  // lines to reproduce; the gate excludes which lines it scores. Each is correct on its
  // own and the failure that matters is them disagreeing: a line the prompt demands but
  // the gate scores is a paragraph the agent is ordered to write and then punished for.
  // Both are driven from one list, and this asserts that is actually true rather than
  // merely intended.
  const HELD: HeldParagraph[] = [
    { sequence_position: 2, text: CTA },
    { sequence_position: 3, text: 'Worth a quick call to see if it fits?' },
  ]

  it('every line the prompt names is excluded from the scored surface', () => {
    const block = buildHeldParagraphsBlock(HELD)
    for (const h of HELD) {
      expect(block).toContain(h.text)
    }
    const body = emailOf(PLAIN_PARAGRAPHS).body
    const surface = authoredProse(body, SENDER, COMPANY, HELD.map(h => h.text))
    expect(surface).not.toContain(CTA)
  })

  it('groups by email so a CTA is never offered for the wrong position', () => {
    const block = buildHeldParagraphsBlock(HELD)
    expect(block).toContain('Email 2 must end with')
    expect(block).toContain('Email 3 must end with')
  })

  it('renders nothing at all when nothing is held', () => {
    // An empty block must be empty, not a heading with no content under it. Ordinary
    // generation holds nothing, and a stray heading would be prompt noise on every run.
    expect(buildHeldParagraphsBlock([])).toBe('')
  })
})

describe('the grade violation names the lever, because it IS the retry instruction', () => {
  // buildPriorAttemptBlock renders these strings verbatim into the next attempt's prompt,
  // so anything absent here is absent from the correction the model is asked to make.
  //
  // MEASURED. On the run of 2026-09-22 the message carried the grade and its three inputs
  // and nothing else, and 6 of 7 Email 1 retries came back at the SAME four sentences as
  // the attempt they were correcting. A model told "grade 8.0, 59 words, 4 sentences, 1.51
  // syllables per word" can only see that splitting would help by rederiving the formula.
  const issue = () => gradeIssues(emailOf(DENSE_PARAGRAPHS))[0]

  it('names sentence length as the lever, not just the grade', () => {
    expect(issue()).toContain('THE LEVER IS SENTENCE LENGTH')
  })

  it('gives the average words per sentence and the cap to compare it against', () => {
    // 37 words across 5 sentences is 7.4, against Email 2's cap of 25.
    expect(issue()).toContain('averages 7.4 words per sentence')
    expect(issue()).toContain('against a cap of 25')
  })

  it('quotes a longest sentence, so the correction has a target', () => {
    // Asserted against the MEASURED maximum rather than a guessed string. Three sentences
    // in this fixture tie at 9 words, so pinning one by hand makes the test a statement
    // about sort stability instead of about the message.
    const text = issue()
    expect(text).toContain('Your longest sentence is')
    const prose = authoredProse(emailOf(DENSE_PARAGRAPHS).body, SENDER, COMPANY, [])
    const sentences = splitSentencesFk(prose)
    const longest = Math.max(...sentences.map(x => x.split(/\s+/).length))
    const quoted = sentences.filter(x => x.split(/\s+/).length === longest)
    expect(quoted.some(x => text.includes(x))).toBe(true)
    expect(text).toContain(`Your longest sentence is ${longest} words`)
  })

  it('still reports syllables per word, which is the second lever', () => {
    expect(issue()).toContain('syllables per word')
  })

  it('cites Email 1 cap of 12 when the email is Email 1, and 25 when it is not', () => {
    // THE PAIR. The same failing prose, two positions, and the cap quoted in the retry
    // instruction must follow the position. Proves the message reads sentenceWordCapFor
    // rather than one constant.
    const atOne: EmailRecord = {
      ...emailOf(DENSE_PARAGRAPHS),
      sequence_position: 1,
      subject_line: 'quick question',
      subject_char_count: 'quick question'.length,
    }
    const one = validateEmails([atOne], SENDER, COMPANY)
      .filter(v => v.issue.includes('reading grade'))
      .map(v => v.issue)
    expect(one).toHaveLength(1)
    expect(one[0]).toContain(`against a cap of ${EMAIL1_MAX_SENTENCE_WORDS}`)
    expect(gradeIssues(emailOf(DENSE_PARAGRAPHS))[0]).toContain('against a cap of 25')
  })
})

describe('the system prompt states the same cap the code enforces', () => {
  // THE TWO COPIES OF THE FRAME CANNOT INTERPOLATE INTO EACH OTHER. The TypeScript prompt
  // renders ${EMAIL1_MAX_SENTENCE_WORDS}; docs/prompts/messaging-agent.md is a flat file
  // and hardcodes the number. That is exactly the drift CLAUDE.md warns about for the word
  // limits, so it gets a test rather than a reminder.
  it('messaging-agent.md names the current Email 1 cap', () => {
    const md = readFileSync(join(process.cwd(), 'docs', 'prompts', 'messaging-agent.md'), 'utf-8')
    expect(md).toContain(`EMAIL 1'S SENTENCE CAP IS ${EMAIL1_MAX_SENTENCE_WORDS} WORDS`)
    expect(md).toContain(`${EMAIL1_MAX_SENTENCE_WORDS}-word cap`)
  })

  it('messaging-agent.md no longer offers the withdrawn two-sentence permission', () => {
    const md = readFileSync(join(process.cwd(), 'docs', 'prompts', 'messaging-agent.md'), 'utf-8')
    expect(md).not.toContain('UP TO TWO SENTENCES')
    expect(md).not.toContain('One or two short sentences')
  })
})
