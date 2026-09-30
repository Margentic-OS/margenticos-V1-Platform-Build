// A DATE IN COLD EMAIL IS A MONTH. NOT A DAY, AND NOT A YEAR IT DOES NOT NEED.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE 2026-09-30 OPERATOR READ. Across 20 blind-marked Email 1s the same complaint
// appeared four times, in the operator's own words:
//
//   "when we always list the exact date and don't use abbreviations of months, it seems
//    robotic and AI-generated"
//   "the same comment about the date and month"
//   "In this one it's an okay example to include the date, but abbreviate August"
//   "I don't need to know the date. The date does not need to be listed for this one"
//
// WHY THE DAY IS THE TELL. Nobody writing to a stranger about something that stranger did
// says "on 27 April". They say "in April", or they say nothing. The day is precision the
// sender has no reason to have offered, so offering it reads as a record being read out.
// It is the same register fault as a trademark symbol and the same register fault as a
// revenue figure: individually defensible, collectively unmistakable.
//
// THE YEAR IS A DIFFERENT RULE AND IT POINTS THE OTHER WAY. An event from a previous year
// MUST name its year, and that is measured: a September 2026 reader took a month-only
// observation about a 2025 event as two months old when it was fourteen. See event-year.ts.
//
// ─── SO THE YEAR HALF REJECTS THE CURRENT YEAR AND NOTHING ELSE ──────────────
//
// That is what makes the two gates unable to contradict each other, and it is structural
// rather than a threshold that happens to line up: event-year.ts only ever DEMANDS a year
// that is not the current one, and this file only ever REJECTS the current one. There is no
// year both can speak about, so there is always a legal move. Getting that wrong is how
// Email 1's word floor produced three gates and no legal move in September, seven model
// calls burned discovering it.
//
// AND IT MUST SIT BESIDE A MONTH. Measured 2026-09-30 over 221 stored personalised
// openings. A bare four-digit-year rule flagged 43 emails and 56% of them were wrong, in
// two families:
//
//   the year is part of a NAME        a trends report, an awards shortlist, a conference and
//                                     an industry survey, each with the year IN ITS TITLE.
//                                     Six of the 43. The year is how the thing is called, so
//                                     removing it renames it. Shapes only here: the real
//                                     titles identify real prospects.
//   the year is a START DATE          "since 2012", "since 1981", "going back to 2008".
//                                     Honest copy about an ongoing state, and event-year.ts
//                                     says so explicitly.
//
// Requiring a month immediately beside the year removes both families without a single
// extra rule: a name carries no month, and a start date in an earlier year is not the
// current year. Re-measured with the month requirement: 13 hits, 12 of them the operator's
// own complaint, one arguable ("from June 2025 to June 2026", where the range reads better
// with both ends). That is the trade made deliberately.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not decide WHETHER the timing is worth
// mentioning at all. That is a judgement about whether the date adds meaning to this
// particular sentence, it varies by finding, and it belongs to the copy reviewer rather
// than to a regex. This file decides only the GRANULARITY of a date that is mentioned.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Month names and the abbreviations a writer actually produces.
 *
 * NOT CLIENT VOCABULARY. These are English month names, the same kind of language-level
 * list as the relative-time phrases, and they carry no market, industry or offer in them.
 */
const MONTH = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`

/**
 * A day of the month, 1 to 31, optionally ordinal.
 *
 * FENCED BY DIGIT LOOKAROUNDS ON BOTH SIDES, which is what stops "July 2026" reading as
 * July the 20th. Without the trailing `(?!\d)` the alternation matches "20" and leaves "26"
 * behind, and every month-and-year phrase in the corpus becomes a day-and-month hit.
 */
const DAY = String.raw`(?<!\d)(?:0?[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?(?!\d)`

export interface DateGranularityFault {
  /** 'day' — a day-of-month was named. 'year' — the current year, beside a month. */
  kind: 'day' | 'year'
  /** The offending text, as written. */
  match: string
  sentence: string
}

/**
 * Every day-of-month in the text, in any of the shapes a writer produces.
 *
 * "MAY" IS EXCLUDED FROM THE DAY-FIRST SHAPE, and only from that one. "12 may be enough"
 * is ordinary English in which "may" is a modal verb, and the day-first pattern cannot tell
 * it from "12 May". The month-first shape has no such ambiguity, because "May 12" is not a
 * sentence. Measured on the stored cohort: the day-first shape with "may" included fired on
 * nothing that was a date, and excluding it loses no real hit.
 */
const DAY_SHAPES: RegExp[] = [
  // "September 13", "Sept 13th", "September 13, 2026"
  new RegExp(String.raw`\b${MONTH}\s+${DAY}`, 'gi'),
  // "27 April", "13th of September". `may` removed: see above.
  new RegExp(
    String.raw`${DAY}(?:\s+of)?\s+${MONTH.replace('|may|', '|')}\b`,
    'gi',
  ),
  // "13/09", "09/13/2026", "2026-09-13". A slashed or dashed date is always day-granular.
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /(?<![\d/-])\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?(?![\d/-])/g,
]

/**
 * The current year written beside a month, in either order: "July 2026", "2026 July".
 *
 * BUILT PER CALL from `now`, because the year it rejects is a fact about when the email is
 * being written and a module-level constant would freeze it at whatever year this file was
 * loaded in. A gate that silently stops working on 1 January is worse than no gate.
 */
function currentYearBesideMonth(now: Date): RegExp {
  const year = now.getUTCFullYear()
  return new RegExp(
    String.raw`\b(?:${MONTH}\s+(?:\d{1,2}(?:st|nd|rd|th)?,?\s+)?${year}|${year}\s+${MONTH})\b`,
    'gi',
  )
}

/**
 * The faults in one piece of copy.
 */
export function findDateGranularityFaults(
  text: string,
  now: Date,
  sentencesOf: (t: string) => string[],
): DateGranularityFault[] {
  if (!text?.trim()) return []
  const faults: DateGranularityFault[] = []

  for (const sentence of sentencesOf(text)) {
    for (const shape of DAY_SHAPES) {
      // A fresh lastIndex per sentence. A shared /g regex resumes from where it stopped,
      // which makes a detector that alternates between finding and missing the same input.
      shape.lastIndex = 0
      for (const m of sentence.matchAll(shape)) {
        faults.push({ kind: 'day', match: m[0].trim(), sentence: sentence.trim() })
      }
    }

    const yearShape = currentYearBesideMonth(now)
    for (const m of sentence.matchAll(yearShape)) {
      faults.push({ kind: 'year', match: m[0].trim(), sentence: sentence.trim() })
    }
  }

  return faults
}

/** The rewrite instruction. Names the legal form, not the rule. */
export function dateGranularityFeedback(fault: DateGranularityFault): string {
  if (fault.kind === 'day') {
    return (
      `"${fault.match}" names a day of the month: ${JSON.stringify(fault.sentence)}. ` +
      'Name the month alone, or drop the date. A day is precision a stranger has no reason ' +
      'to have offered, and it reads as a record being read out.'
    )
  }
  return (
    `"${fault.match}" names the current year: ${JSON.stringify(fault.sentence)}. ` +
    'Drop the year and keep the month. The month alone is enough for something that ' +
    'happened this year, and a year belongs in the copy only when the event is from an ' +
    'earlier one.'
  )
}
