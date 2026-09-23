// AN EVENT FROM ANOTHER YEAR MUST SAY WHICH YEAR.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE 2026-09-23 MEASUREMENT. The research candidate read "She co-hosted a webinar with
// GrantExec on July 24, 2025". The shipped observation read "You co-hosted a webinar in
// July on the One Big Beautiful Bill". A reader in September 2026 reads "in July" as two
// months ago. It was fourteen.
//
// The run log says exactly how it happened: the first attempt was over the per-sentence
// word cap, and the retry shortened it. THE YEAR IS THE CHEAPEST WORD TO CUT, because
// nothing told the writer it was load-bearing. Erin Spencer's observation in the same run
// DID say "in July 2026", so the writer names the year when it has room and drops it when
// it does not, which is the worst possible rule: the year survives where it does not matter
// and disappears where it does.
//
// DETERMINISTIC, PER ADR-018. This is a date comparison and a substring search. There is no
// judgement in it, and a prompt instruction would be advisory (ADR-028) against a model that
// is already under length pressure when it makes this mistake.
//
// WHAT THIS IS NOT. It is not a recency floor. A candidate from 2012 is still usable: "you
// have run 8 Consulting as its sole principal since September 2012" is honest copy about an
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
 * The year the observation is REQUIRED to name, or null when the rule does not apply.
 *
 * Applies only when all three hold:
 *   1. the selected candidate carries a usable year,
 *   2. that year is not the year the email is being written in, and
 *   3. the observation does not already contain it.
 *
 * An undated candidate is out of scope. It has its own problem, which is that nobody can
 * tell when it happened, and inventing a year for it would be worse than saying nothing.
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
 * The gate line, which is also the retry feedback: the writer is told the year and told to
 * put it in, rather than being told it failed and left to guess what would pass.
 */
export function eventYearGateMessage(year: number): string {
  return `the observation describes an event from ${year} but never says ${year}; a reader assumes ` +
    `anything undated is recent, so name the year in the observation (keep it within the sentence ` +
    `word cap by cutting something else)`
}
