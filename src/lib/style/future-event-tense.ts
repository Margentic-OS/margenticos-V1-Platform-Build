// AN EVENT THAT HAS NOT HAPPENED YET MUST NOT BE WRITTEN IN THE PAST TENSE.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE FAULT. A finding says a person IS LEADING a session next month. The copy says "You
// led". To the reader that is not a tense slip, it is a statement that something already
// happened which has not, and it is checkable by them in one second.
//
// It arises because the writer is given an observation and a date and writes naturally in
// the register of a thing that has been observed. Everything else in the findings is past,
// so the past is the default, and a future date is the one case where the default is wrong.
//
// DETERMINISTIC, PER ADR-018. Whether a date is after today is subtraction. The only
// judgement is WHICH FINDING a sentence is about, and that is the content comparison the
// relative-time and event-year gates already make, the same way, for the same reason.
//
// ═══ WHY THE PAST TENSE IS DETECTED BY SUBJECT AND NOT BY "ed" ═══
//
// A bare \w+ed is not a past-tense detector, and this project has already paid for
// believing it is: a FACT_MARKER built that way read "focused" as a past-tense fact. Past
// participles, adjectives and ordinary nouns all end in those two letters.
//
// So the test is SUBJECT PLUS VERB: the reader, or their firm, followed by a past form. That
// is the construction the fault actually takes, it keeps the list of verbs short enough to
// read, and it cannot fire on an adjective because an adjective does not follow "you" in
// that position.

import { contentOverlap } from '@/lib/agents/research/synthesize'
// ONE DATE PARSER, shared with the relative-time gate. See parseFindingDate for why a
// free-text date must not be handed to new Date().
import { parseFindingDate } from './relative-time'

/**
 * Past forms that follow a subject. Irregulars listed outright, because they carry no ending
 * to match on; regulars limited to the verbs that describe a dated event, because the whole
 * list only has to cover what a finding can be about.
 */
const PAST_VERB =
  '(led|spoke|ran|won|took|gave|held|made|went|came|saw|wrote|built|sold|brought|began|' +
  'hosted|launched|published|opened|joined|shared|posted|announced|attended|presented|' +
  'delivered|completed|finished|closed|started|appeared|released|added|moved|chaired|' +
  'keynoted|founded|received|earned|landed|secured)'

/**
 * The reader, or their firm, as the subject. "You led", "Your team ran", "<Firm> hosted".
 * A capitalised name is accepted because a finding routinely names the company.
 */
const SUBJECT_THEN_PAST = new RegExp(
  `\\b(?:you|your\\s+[a-z][\\w-]*(?:\\s+[a-z][\\w-]*)?|[A-Z][A-Za-z0-9&.'-]+)\\s+${PAST_VERB}\\b`,
  'i',
)

export interface FutureEventTenseFault {
  /** The sentence as written. */
  sentence: string
  /** The past-tense construction found in it. */
  matched: string
  /** The event's date, which is still ahead. */
  eventDate: string
}

/**
 * Every sentence that writes an event in the past when its finding puts it in the future.
 *
 * FAILS OPEN when no finding resembles the sentence, the same way the relative-time gate
 * does: a past-tense sentence about something outside the findings is the traceability
 * check's problem, and demanding a tense change from an unrelated row produces a rewrite
 * nobody can make.
 */
export function findFutureEventTenseFaults(
  text: string,
  candidates: ReadonlyArray<{ date?: string | null; observation?: string | null }>,
  now: Date,
  sentencesOf: (t: string) => string[],
): FutureEventTenseFault[] {
  if (!text?.trim()) return []
  const faults: FutureEventTenseFault[] = []

  for (const sentence of sentencesOf(text)) {
    const m = sentence.match(SUBJECT_THEN_PAST)
    if (!m) continue

    // The best-matching candidate is the event this sentence is about. Same rule, same
    // threshold, as the relative-time gate: one way of deciding, not two.
    // THE BEST MATCH FIRST, THEN ITS DATE. Scoring only the candidates whose date parses
    // would match the sentence to an event it is not about, which is exactly the defect
    // measured in relative-time.ts on 2026-09-30: a chosen candidate dated "September 12-17,
    // 2026" is unreadable, and the sentence fell through to a 2018 row.
    let best: { raw: string | null | undefined; score: number } | null = null
    for (const c of candidates) {
      const score = contentOverlap(sentence, c.observation ?? '')
      if (score >= 0.2 && (best === null || score > best.score)) best = { raw: c.date, score }
    }
    if (best === null) continue
    const when = parseFindingDate(best.raw)
    if (!when) continue
    if (when.getTime() <= now.getTime()) continue

    faults.push({ sentence: sentence.trim(), matched: m[0], eventDate: String(best.raw) })
  }
  return faults
}

/** The rewrite instruction. Names the date and the phrase, not the rule. */
export function futureEventTenseFeedback(fault: FutureEventTenseFault): string {
  return (
    `writes ${JSON.stringify(fault.matched)} about something dated ${fault.eventDate}, which ` +
    `has not happened yet: ${JSON.stringify(fault.sentence)}. Write it as still to come.`
  )
}
