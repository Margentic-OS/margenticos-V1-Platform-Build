// POSITIVE CONTROL, BOTH DIRECTIONS, for the reading-grade gate in validateEmails.
//
// A gate that rejects everything is an outage and a gate that rejects nothing is
// decoration, and neither is distinguishable from a working gate by watching it fail. So
// the central pair here is two emails that differ by EXACTLY ONE WORD, "variability"
// against "unpredictability", with the same 34 words and the same 3 sentences. One scores
// 7.92 and passes, the other 8.27 and fails. Nothing else about them differs, so the
// verdict can only have come from the vocabulary.
//
// THE FIXTURES WERE REBUILT on 2026-09-23 when the emails 2 to 4 ceiling moved 5 -> 8. The
// old pair straddled 5, and at 8 BOTH of its members passed. That is a fixture that has
// stopped testing its gate while still reporting green, which is the failure this whole
// file exists to make impossible.
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
  FOLLOWUP_MAX_SENTENCE_WORDS,
  type EmailRecord,
  type HeldParagraph,
} from '../messaging-generation-agent'
import { fleschKincaidGrade, splitSentencesFk, MAX_READING_GRADE, EMAIL1_MAX_READING_GRADE } from '@/lib/style/reading-grade'
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
  'Most firms we speak to have the same problem and it arrives through established working relationships.',
  //                                                       vv this word is the whole experiment
  'When that source goes quiet, nothing else is operating and the variability complicates planning.',
]
// Fails even at Email 1's looser ceiling, with every sentence inside the 12-word cap, so
// it isolates the GRADE from the sentence-length gate at position 1.
const VERY_DENSE_PARAGRAPHS = [
  'Most organisations demonstrate identical operational difficulties. New business materialises through established professional relationships.',
  'When that source deteriorates, nothing else is operational. The variability complicates recruitment decisions considerably.',
]
const DENSE_PARAGRAPHS = [
  'Most firms we speak to have the same problem and it arrives through established working relationships.',
  'When that source goes quiet, nothing else is operating and the unpredictability complicates planning.',
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

/** The same paragraphs judged at a chosen sequence position. */
const gradeIssuesAt = (paragraphs: string[], pos: number): string[] => {
  const base = emailOf(paragraphs)
  const email: EmailRecord = pos === 1
    ? { ...base, sequence_position: 1, subject_line: 'quick question', subject_char_count: 14 }
    : { ...base, sequence_position: pos }
  return validateEmails([email], SENDER, COMPANY)
    .filter(v => v.issue.includes('reading grade'))
    .map(v => v.issue)
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
    expect(differing).toEqual(['variability'])
  })

  it('straddles the threshold, and the threshold is where the constant says', () => {
    // Pins the actual numbers. If the instrument drifts, this fails here with a readable
    // message rather than silently turning one of the gate tests into a tautology.
    const plain = fleschKincaidGrade(PLAIN_PARAGRAPHS.concat(CTA).join('\n\n'))!
    const dense = fleschKincaidGrade(DENSE_PARAGRAPHS.concat(CTA).join('\n\n'))!
    expect(plain.words).toBe(dense.words)
    expect(plain.sentences).toBe(dense.sentences)
    expect(plain.grade).toBeCloseTo(7.92, 1)
    expect(dense.grade).toBeCloseTo(8.27, 1)
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
    expect(issues[0]).toContain('8.3')
    expect(issues[0]).toContain(`maximum of ${MAX_READING_GRADE}`)
  })

  it('STAYS SILENT on the same prose one word plainer', () => {
    expect(gradeIssues(emailOf(PLAIN_PARAGRAPHS))).toEqual([])
  })
})

describe('a held paragraph cannot decide the verdict', () => {
  it('a held CTA is EXCLUDED, and that makes the gate stricter rather than softer', () => {
    // The same email, twice, differing only in whether the CTA was authored or supplied.
    // Counted: 7.92, passes. Held and therefore excluded: 10.32, fails.
    //
    // This is the direction that surprised us. Holding a paragraph was expected to protect
    // an email from a failure it could not fix; measured on the live document it was doing
    // the opposite, lending every email between +0.80 and +2.02 grades of credit for a
    // question the agent was not being asked to write.
    const email = emailOf(PLAIN_PARAGRAPHS)
    expect(gradeIssues(email)).toEqual([])
    const withHeld = gradeIssues(email, [CTA])
    expect(withHeld).toHaveLength(1)
    expect(withHeld[0]).toContain('10.3')
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

describe('the grade violation names WHAT THE GRADE NEEDS, never a cap', () => {
  // buildPriorAttemptBlock renders these strings verbatim into the next attempt's prompt,
  // so anything absent here is absent from the correction the model is asked to make.
  //
  // THE BUG THIS REPLACES. The message used to quote the email's SENTENCE CAP beside
  // "break it". For Email 1 the cap was binding and it worked. For emails 2 to 4 the cap
  // was 25 and not binding, so the message contradicted itself: "Your longest sentence is
  // 19 words ... against a cap of 25 ... break it." Every failure in the run of 2026-09-23
  // was an email 2 or 3 whose longest sentence ran 17 to 24 words: inside the cap, too long
  // for the grade. The target is now derived from the formula instead.
  const issue = () => gradeIssues(emailOf(DENSE_PARAGRAPHS))[0]

  it('NEVER quotes a sentence cap', () => {
    // The regression is specifically re-introducing a non-binding number. Asserted as an
    // absence, because that is the shape the defect took.
    expect(issue()).not.toContain('cap of')
    expect(issue()).not.toContain(`cap is ${FOLLOWUP_MAX_SENTENCE_WORDS}`)
    expect(issue()).not.toContain(`cap is ${EMAIL1_MAX_SENTENCE_WORDS}`)
  })

  it('gives the average words per sentence the grade actually requires', () => {
    // DENSE is 34 words across 3 sentences at 1.65 syllables per word, at the emails 2-4
    // ceiling of 8.  wps = (ceiling + 15.59 - 11.8*spw) / 0.39
    const r = fleschKincaidGrade(authoredProse(emailOf(DENSE_PARAGRAPHS).body, SENDER, COMPANY, []))!
    const needed = (MAX_READING_GRADE + 15.59 - 11.8 * r.syllablesPerWord) / 0.39
    expect(issue()).toContain(`average ${needed.toFixed(1)} words per sentence or fewer`)
  })

  it('converts that into a sentence count the model can count to', () => {
    const r = fleschKincaidGrade(authoredProse(emailOf(DENSE_PARAGRAPHS).body, SENDER, COMPANY, []))!
    const needed = (MAX_READING_GRADE + 15.59 - 11.8 * r.syllablesPerWord) / 0.39
    const sentences = Math.ceil(r.words / needed)
    expect(issue()).toContain(`AT LEAST ${sentences} sentences`)
    // And the count must actually be MORE than it wrote, or the instruction is vacuous.
    expect(sentences).toBeGreaterThan(r.sentences)
  })

  it('reports what it measured, so the model can check the arithmetic', () => {
    const r = fleschKincaidGrade(authoredProse(emailOf(DENSE_PARAGRAPHS).body, SENDER, COMPANY, []))!
    expect(issue()).toContain(`${r.words} words are split across ${r.sentences} sentences`)
    expect(issue()).toContain(`averages ${r.wordsPerSentence.toFixed(1)} words each`)
  })

  it('quotes a longest sentence, so the correction has a target', () => {
    const text = issue()
    const prose = authoredProse(emailOf(DENSE_PARAGRAPHS).body, SENDER, COMPANY, [])
    const sentences = splitSentencesFk(prose)
    const longest = Math.max(...sentences.map(x => x.split(/\s+/).length))
    expect(text).toContain(`Your longest sentence is ${longest} words`)
    expect(sentences.filter(x => x.split(/\s+/).length === longest).some(x => text.includes(x))).toBe(true)
  })

  it('still names syllables per word as the second lever', () => {
    expect(issue()).toContain('syllables per word')
  })

  it('cites the grade ceiling of its own position', () => {
    expect(gradeIssuesAt(VERY_DENSE_PARAGRAPHS, 1)[0]).toContain('above the maximum of 6')
    expect(gradeIssuesAt(VERY_DENSE_PARAGRAPHS, 2)[0]).toContain('above the maximum of 8')
  })

  it('says SPLITTING WILL NOT FIX IT when the vocabulary alone puts it over', () => {
    // VERY_DENSE is 18.8 at 2.4 syllables per word. The required words-per-sentence goes
    // negative, so instructing a split would be an instruction the model cannot carry out.
    // Telling it to split anyway is how a retry gets burned for nothing.
    const text = gradeIssuesAt(VERY_DENSE_PARAGRAPHS, 2)[0]
    expect(text).toContain('SPLITTING SENTENCES WILL NOT FIX IT')
    expect(text).not.toContain('AT LEAST')
  })
})

describe('the grade GATE reads the per-position ceiling, not one constant', () => {
  // THE MUTATION THIS EXISTS TO KILL: replacing readingGradeCapFor(pos) in the gate with
  // the flat MAX_READING_GRADE. Every other test in this file still passed under that
  // mutation, because they all measure emails at position 2 where the two agree.
  //
  // THE DIRECTION OF THIS PAIR FLIPPED on 2026-09-23 and the new direction is the one
  // pinned. Email 1's ceiling of 6 used to be the LOOSER of the two; against the follow-ups'
  // 8 it is now the STRICTER. So the pair is one body at grade 7.92, judged twice: legal in
  // emails 2 to 4, rejected in Email 1. Written the other way round it would still have
  // passed under the mutation this exists to kill.
  it('THE PAIR: prose at grade 7.9 is rejected in Email 1 and accepted in Email 2', () => {
    const grade = fleschKincaidGrade(PLAIN_PARAGRAPHS.concat(CTA).join('\n\n'))!.grade
    expect(grade).toBeGreaterThan(EMAIL1_MAX_READING_GRADE)
    expect(grade).toBeLessThanOrEqual(MAX_READING_GRADE)
    expect(gradeIssuesAt(PLAIN_PARAGRAPHS, 1)).toHaveLength(1)
    expect(gradeIssuesAt(PLAIN_PARAGRAPHS, 2)).toEqual([])
  })
})

describe('the system prompt states the same cap the code enforces', () => {
  // THE TWO COPIES OF THE FRAME CANNOT INTERPOLATE INTO EACH OTHER. The TypeScript prompt
  // renders the cap constants; docs/prompts/messaging-agent.md is a flat file and
  // hardcodes the number. That is exactly the drift CLAUDE.md warns about for the word
  // limits, so it gets a test rather than a reminder. It has already caught one stale
  // number, when the cap moved from 12 to 15.
  it('messaging-agent.md names BOTH current caps', () => {
    const md = readFileSync(join(process.cwd(), 'docs', 'prompts', 'messaging-agent.md'), 'utf-8')
    expect(md).toContain(
      `THE SENTENCE CAP IS PER EMAIL. EMAIL 1: ${EMAIL1_MAX_SENTENCE_WORDS} words. ` +
      `EMAILS 2, 3 and 4: ${FOLLOWUP_MAX_SENTENCE_WORDS} words.`)
  })

  it('messaging-agent.md still warns against carrying Email 1 rhythm into the follow-ups', () => {
    // The cap alone does not carry the reason. This sentence is why emails 2 to 4 were
    // allowed back to 25, and losing it is how the mistake gets made again.
    const md = readFileSync(join(process.cwd(), 'docs', 'prompts', 'messaging-agent.md'), 'utf-8')
    expect(md).toContain("DO NOT CARRY EMAIL 1'S RHYTHM INTO THE FOLLOW-UPS")
  })

  it('messaging-agent.md no longer offers the withdrawn two-sentence permission', () => {
    const md = readFileSync(join(process.cwd(), 'docs', 'prompts', 'messaging-agent.md'), 'utf-8')
    expect(md).not.toContain('UP TO TWO SENTENCES')
    expect(md).not.toContain('One or two short sentences')
  })
})
