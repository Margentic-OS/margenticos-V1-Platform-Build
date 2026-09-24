import { contentOverlap } from './synthesize'

// AN EVENT FROM ANOTHER YEAR MUST SAY WHICH YEAR.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE 2026-09-23 MEASUREMENT. A research candidate was dated to the day, in the PREVIOUS
// calendar year. The shipped observation named the month and dropped the year, so a reader
// in September 2026 read it as two months ago. It was fourteen.
//
// The run log says exactly how it happened: the first attempt was over the per-sentence
// word cap, and the retry shortened it. THE YEAR IS THE CHEAPEST WORD TO CUT, because
// nothing told the writer it was load-bearing. Another prospect's observation in the same
// run DID name the year, on an event from the CURRENT year, so the writer names the year
// when it has room and drops it when it does not. That is the worst possible rule: the year
// survives where it does not matter and disappears where it does.
//
// DETERMINISTIC, PER ADR-018. This is a date comparison and a substring search. There is no
// judgement in it, and a prompt instruction would be advisory (ADR-028) against a model that
// is already under length pressure when it makes this mistake.
//
// WHAT THIS IS NOT. It is not a recency floor. A candidate from a decade ago is still
// usable: "you have run it as sole principal since September 2012" is honest copy about an
// ongoing state, and it names its year, so it passes. Measured across the same 20: six
// winners were dated outside the current year, four already named the year unprompted, and
// a 180-day floor would have rejected all six, four of them wrongly.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The four-digit year a date string refers to, or null when it carries none.
 *
 * FIRST YEAR IN THE STRING, deliberately. A candidate date is a date, not prose, and the
 * shapes seen in production are "2025-07-24", "2025-07", "2025" and "2021-01-01 to
 * 2023-01-01". For a range, the first year is the START, which is the conservative reading:
 * it is the year furthest from now, so naming it is the stronger requirement.
 */
export function eventYear(date: string | null | undefined): number | null {
  if (!date) return null
  const m = String(date).match(/\b(19|20)\d{2}\b/)
  return m ? Number(m[0]) : null
}

/**
 * The year the observation is REQUIRED to name for ONE event, or null when the rule does
 * not apply.
 *
 * Applies only when all three hold:
 *   1. the event carries a usable year,
 *   2. that year is not the year the email is being written in, and
 *   3. the observation does not already contain it.
 *
 * An undated event is out of scope. It has its own problem, which is that nobody can tell
 * when it happened, and inventing a year for it would be worse than saying nothing.
 */
export function missingEventYear(
  observation: string,
  candidateDate: string | null | undefined,
  now: Date = new Date(),
): number | null {
  const year = eventYear(candidateDate)
  if (year === null) return null
  if (year === now.getUTCFullYear()) return null
  // FOUR DIGITS ONLY. "'25" and "two years ago" are not accepted, and that is deliberate
  // rather than an oversight: an apostrophe year is ambiguous in an email that also carries
  // revenue figures, and a relative phrase goes stale the moment the copy is stored and sent
  // weeks later, which is the whole failure this gate exists to stop.
  return observation.includes(String(year)) ? null : year
}

/**
 * How much of the observation's content has to be shared with a candidate before that
 * candidate counts as an event the observation NAMES.
 *
 * TWO RULES, AND THE RELATIVE ONE IS THE DECISION. A candidate is described when it scores
 * at least HALF the best score, which is a statement about shape rather than a magnitude
 * tuned to one cohort, and separately clears a small absolute floor so that a set of
 * uniformly weak scores does not elect a winner by default.
 *
 * MEASURED on the six attempts of 2026-09-24 that this rule was written for. The candidate
 * the observation actually described scored 0.31 to 1.00; the candidate synthesis had
 * SELECTED, and which the old gate read, scored 0.00 to 0.29 on the same text. Richard's
 * selected candidate scored 0.00 on every attempt: the observation and it share no content
 * word at all.
 */
const EVENT_MATCH_FLOOR = 0.20
const EVENT_MATCH_RELATIVE = 0.5

/**
 * EVERY YEAR THE OBSERVATION OWES, for each event it actually names.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS REPLACED "THE SELECTED CANDIDATE'S DATE". Measured 2026-09-24.
 *
 * The gate used to read the date of the candidate SYNTHESIS SELECTED, on the reasoning that
 * the observation is the thing under test so it should not be asked what year it means. That
 * is sound when the writer describes the selected candidate. It is unsatisfiable when the
 * writer describes a different one, and the writer does that routinely, because every
 * candidate is in front of it and it picks the one that writes best.
 *
 *   Erin:     selected c6, dated 2025-11-01, "running EdgeBrook Lane alongside a second
 *             venture". WRITTEN: c1, dated 2026-07-23, the HR Consultant job posting.
 *   Richard:  selected c9, dated 2025-01-01, "running Link Stone alongside a concurrent CFO
 *             role". WRITTEN: c5, dated 2026-08-25, a blog post.
 *
 * Both writers named the year of the event they had written about, 2026, on every attempt.
 * The gate compared that text against a 2025 date from an event they had not mentioned and
 * demanded "2025". THERE WAS NO LEGAL MOVE: naming 2025 would have been false, and the only
 * way to satisfy the gate was to write about a different event entirely. Six attempts, two
 * prospects, both emails lost, and the same gate message every time.
 *
 * It is the validate-one-thing-return-another shape: the check ran on the year of event A
 * against the text describing event B, and the failure it reported was real about nothing.
 *
 * THE FIX IS TO ASK WHICH EVENT THE TEXT IS ABOUT, which is a content comparison, not a
 * judgement, so it stays deterministic per ADR-018. The observation is still never asked
 * what year it means: it is asked which candidate it resembles, and the YEAR comes from that
 * candidate's stored date exactly as before.
 *
 * MORE THAN ONE EVENT, because an observation may name a main event and a supporting one,
 * and both owe their years. That is what the relative threshold is for.
 *
 * FALLS OPEN WHEN NOTHING MATCHES. If no candidate clears the floor the observation is about
 * something outside the candidate list, and the gate returns nothing rather than demanding a
 * year from an unrelated row. Failing closed here is exactly what produced the incident
 * above: a demand no rewrite could satisfy costs the prospect every remaining attempt, and
 * the traceability gates already own an observation that is not in the findings.
 * ═════════════════════════════════════════════════════════════════════════════
 */
export function missingEventYears(
  observation: string,
  candidates: ReadonlyArray<{ date?: string | null; observation?: string | null }>,
  now: Date = new Date(),
): number[] {
  if (!observation.trim()) return []

  const scored = candidates
    .map(c => ({ candidate: c, score: contentOverlap(observation, c.observation ?? '') }))
    .filter(s => s.score >= EVENT_MATCH_FLOOR)
  if (scored.length === 0) return []

  const best = Math.max(...scored.map(s => s.score))
  const described = scored.filter(s => s.score >= best * EVENT_MATCH_RELATIVE)

  const owed = new Set<number>()
  for (const { candidate } of described) {
    const year = missingEventYear(observation, candidate.date, now)
    if (year !== null) owed.add(year)
  }
  return [...owed].sort((a, b) => a - b)
}

/**
 * The gate line, which is also the retry feedback: the writer is told the year and told to
 * put it in, rather than being told it failed and left to guess what would pass.
 */
export function eventYearGateMessage(year: number): string {
  return `the observation describes an event from ${year} but never says ${year}; a reader assumes ` +
    `anything undated is recent, so name the year in the observation (keep it within the sentence ` +
    `word cap by cutting something else)`
}
