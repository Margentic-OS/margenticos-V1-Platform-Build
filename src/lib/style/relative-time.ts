// A RELATIVE TIME WORD MUST MATCH THE EVENT'S REAL DATE.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE 2026-09-24 MEASUREMENT. One prospect's Email 1 said "last month" about an event from
// 1 May 2026, on a run date of 24 September. It was four months. Her Email 2 said "ended in
// May" about an event from May 2025, sixteen months earlier, with no year.
//
// "Last month" is the worst kind of wrong: it is specific, it is checkable in a second, and
// it is about the reader's own business. And unlike a name or a figure, it goes stale on
// its own. Copy generated in September and sent in November is wrong by a month more.
//
// DETERMINISTIC, PER ADR-018. Which month "last month" means is subtraction. The only
// judgement is WHICH FINDING the copy is talking about, and that is a content comparison
// the event-year gate already makes the same way, on the same day, for the same reason.
//
// WHAT THIS IS NOT. It is not a ban on relative time. "Last month" is good, plain copy when
// it is true, and the rule leaves it alone when it is.
// ═════════════════════════════════════════════════════════════════════════════

import { contentOverlap } from '@/lib/agents/research/synthesize'

/**
 * How far back each phrase claims the event was, as an inclusive window in MONTHS.
 *
 * WINDOWS, NOT POINTS, because ordinary speech is not exact. "Last month" said on 2 October
 * about something on 30 August is defensible; said about something in May it is not. The
 * windows are deliberately generous: this gate exists to catch a four-month error, not to
 * arbitrate a fortnight.
 */
const RELATIVE_WINDOWS: Array<{ re: RegExp; label: string; minMonths: number; maxMonths: number }> = [
  { re: /\blast week\b/i,            label: 'last week',          minMonths: 0, maxMonths: 1 },
  { re: /\bthis week\b/i,            label: 'this week',          minMonths: 0, maxMonths: 1 },
  { re: /\bthis month\b/i,           label: 'this month',         minMonths: 0, maxMonths: 1 },
  { re: /\blast month\b/i,           label: 'last month',         minMonths: 0, maxMonths: 2 },
  { re: /\brecently\b/i,             label: 'recently',           minMonths: 0, maxMonths: 6 },
  { re: /\bjust (?:announced|launched|published|posted|added|opened|won|landed)\b/i, label: 'just <verb>', minMonths: 0, maxMonths: 3 },
  { re: /\bearlier this year\b/i,    label: 'earlier this year',  minMonths: 0, maxMonths: 12 },
  { re: /\bin the last few months\b/i, label: 'in the last few months', minMonths: 0, maxMonths: 6 },
]

/** Whole months between a stored date and the run date, or null when it carries no date. */
export function monthsAgo(date: string | null | undefined, now: Date): number | null {
  if (!date) return null
  const raw = String(date)
  const parsed = new Date(raw.length === 4 ? `${raw}-01-01` : raw.length === 7 ? `${raw}-01` : raw)
  if (Number.isNaN(parsed.getTime())) return null
  const months =
    (now.getUTCFullYear() - parsed.getUTCFullYear()) * 12 + (now.getUTCMonth() - parsed.getUTCMonth())
  return months < 0 ? null : months
}

export interface RelativeTimeFault {
  /** The phrase as written. */
  phrase: string
  /** How many months ago the event this copy describes actually was. */
  actualMonths: number
  /** The widest the phrase could honestly mean. */
  maxMonths: number
  sentence: string
}

/**
 * Every relative time word in the copy that the findings contradict.
 *
 * WHICH EVENT THE COPY MEANS is decided by content overlap against the candidate list, the
 * same way missingEventYears decides it: the writer chooses which finding to describe, so a
 * rule keyed to one selected candidate measures the wrong event. Matched per SENTENCE,
 * because that is the unit that carries both the phrase and the description of the event.
 *
 * FAILS OPEN when no candidate resembles the sentence. A relative word about something
 * outside the findings is the traceability check's problem, and demanding a date from an
 * unrelated row is how the event-year gate produced demands no rewrite could satisfy.
 */
export function findRelativeTimeFaults(
  text: string,
  candidates: ReadonlyArray<{ date?: string | null; observation?: string | null }>,
  now: Date,
  sentencesOf: (t: string) => string[],
): RelativeTimeFault[] {
  if (!text?.trim()) return []
  const faults: RelativeTimeFault[] = []

  for (const sentence of sentencesOf(text)) {
    const matched = RELATIVE_WINDOWS.filter(w => w.re.test(sentence))
    if (matched.length === 0) continue

    // The best-matching candidate is the event this sentence is about.
    let best: { months: number; score: number } | null = null
    for (const c of candidates) {
      const months = monthsAgo(c.date, now)
      if (months === null) continue
      const score = contentOverlap(sentence, c.observation ?? '')
      if (score >= 0.2 && (best === null || score > best.score)) best = { months, score }
    }
    if (best === null) continue

    for (const w of matched) {
      if (best.months >= w.minMonths && best.months <= w.maxMonths) continue
      faults.push({
        phrase: w.label,
        actualMonths: best.months,
        maxMonths: w.maxMonths,
        sentence: sentence.trim(),
      })
    }
  }
  return faults
}

/** The rewrite instruction. Names the phrase and the real gap, not the rule. */
export function relativeTimeFeedback(fault: RelativeTimeFault): string {
  return (
    `"${fault.phrase}" describes an event from ${fault.actualMonths} months ago: ` +
    `${JSON.stringify(fault.sentence)}. Name the month, or drop the time word. ` +
    'A relative time word also goes stale between writing and sending, so it has to be right ' +
    'by a margin, not just today.'
  )
}
