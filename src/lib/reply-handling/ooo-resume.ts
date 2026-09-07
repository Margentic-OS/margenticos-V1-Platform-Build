// When does a paused sequence start again after an out-of-office reply?
//
// ═══════════════════════════════════════════════════════════════════════════════
// THE FALLBACK IS THE POINT. THE PARSER IS THE OPTIMISATION.
//
// On 2026-09-07 the first two real out-of-office autoreplies this system has ever
// handled both named an explicit return date, both failed to parse, and both wrote
// scheduled_resume_at = NULL:
//
//   "I am out of office through September 8th."          April Beach, 18:58:34Z
//   "I will be out of the office until Sept 8th ..."      Lynn Oser,   18:58:38Z
//
// Two for two. The PRD has always said "Default: 10 business days if no date found",
// and nothing implemented it: the caller wrote whatever the parser returned, including
// null.
//
// A NULL resume is worse than a wrong one. A weak parser produces a date that is early
// or late, and the sequence still restarts. A null produces no defined behaviour at all:
// nothing says when, or whether, that prospect is ever contacted again. So the fallback
// comes first and is unconditional, and the parser only ever improves on it.
//
// ═══════════════════════════════════════════════════════════════════════════════
// ON LOCALE
//
// There is deliberately NO hardcoded list of month names here. Month parsing is handed
// to the platform Date parser, so nothing in this file assumes English.
//
// That is a smaller claim than it sounds and the limit is stated rather than hidden:
// Node's Date parser is itself English-biased, so a German or French autoreply will not
// parse and will take the fallback. That is the correct outcome and the reason the
// fallback is unconditional. Adding a month table per language would be a Rule Zero
// violation, and getting it wrong would be worse than falling back.

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * PRD default: resume 10 business days out when no return date can be read.
 * Business days, not calendar days, because a fortnight of silence over two weekends is
 * not the same as ten working days and the PRD says working days.
 */
export const OOO_FALLBACK_BUSINESS_DAYS = 10

/** Furthest ahead a parsed date is believed. Beyond this it is more likely a misparse. */
export const OOO_MAX_HORIZON_DAYS = 180

export type OooResumeSource = 'parsed' | 'fallback'

export interface OooResume {
  resumeAt: string
  source: OooResumeSource
  /** The substring the date came from, for the action payload. Null on the fallback. */
  matchedText: string | null
}

/**
 * Adds N business days, skipping Saturday and Sunday.
 *
 * Public holidays are NOT modelled, deliberately. They vary by country and by client, and
 * being one day early on a resume is not a failure worth a holiday calendar for.
 */
export function addBusinessDays(from: Date, businessDays: number): Date {
  const result = new Date(from.getTime())
  let remaining = businessDays

  while (remaining > 0) {
    result.setUTCDate(result.getUTCDate() + 1)
    const day = result.getUTCDay()
    if (day !== 0 && day !== 6) remaining--
  }

  return result
}

// Phrases that introduce a return date. "through" and "thru" were added after both of the
// first two real autoreplies used a form the original three patterns did not cover:
// "out of office through September 8th" matched nothing at all.
//
// The date group deliberately does NOT capture an ordinal suffix. Capturing it was the
// second half of the 2026-09-07 failure: the `until` pattern DID match Lynn Oser's
// "Sept 8th", handed "Sept 8th" to the Date parser, and got Invalid Date back. The regex
// worked and the cast destroyed it, which is why that case looked like a matching failure
// and was not.
const RETURN_PHRASE = String.raw`(?:back|returning|return|available|in the office|until|through|thru|til|till|up to and including)`
const ORDINAL = String.raw`(?:st|nd|rd|th)?`
// Connectors that may sit between the phrase and the date, each independently optional.
// "return on the 14th" needs BOTH "on" and "the", which a single alternation could not
// express, and "available from September 14th" needs "from". Both were caught by fixtures.
const CONNECTORS = String.raw`(?:on\s+)?(?:from\s+)?(?:the\s+)?`

const OOO_DATE_PATTERNS: RegExp[] = [
  // "back on September 8th", "until Sept 8", "through September 8th, 2026"
  new RegExp(`${RETURN_PHRASE}\\s+${CONNECTORS}([A-Za-z]+\\s+\\d{1,2})${ORDINAL}(,?\\s+\\d{4})?`, 'i'),
  // "back on 8 September", the ordering most of the world writes
  new RegExp(`${RETURN_PHRASE}\\s+${CONNECTORS}(\\d{1,2})${ORDINAL}\\s+([A-Za-z]+)(,?\\s+\\d{4})?`, 'i'),
  // "returning 09/08/2026"
  new RegExp(`${RETURN_PHRASE}\\s+${CONNECTORS}(\\d{1,2}[/\\-.]\\d{1,2}[/\\-.]\\d{2,4})`, 'i'),
]

/**
 * Reads a return date out of an out-of-office body.
 *
 * Returns null when nothing usable is found. Callers must not treat null as "no resume":
 * use resolveOooResumeAt, which is the only supported entry point.
 */
export function parseOooReturnDate(body: string, now: Date = new Date()): { iso: string; matchedText: string } | null {
  for (const pattern of OOO_DATE_PATTERNS) {
    const match = body.match(pattern)
    if (!match) continue

    // Groups differ per pattern, so rebuild a parseable string rather than assuming
    // match[1] is always the whole date. The ordinal suffix is never included.
    const candidate = buildCandidate(match)
    if (!candidate) continue

    const parsed = parseWithYearRollover(candidate, now)
    if (!parsed) continue

    return { iso: parsed.toISOString(), matchedText: match[0].trim() }
  }

  return null
}

function buildCandidate(match: RegExpMatchArray): string | null {
  const [, first, second, third] = match

  if (!first) return null

  // Numeric form: the whole date is in one group.
  if (/^\d{1,2}[/\-.]/.test(first)) return first

  // "8 September" form: day then month name, with an optional year in group 3.
  if (/^\d{1,2}$/.test(first) && second && /^[A-Za-z]+$/.test(second)) {
    return `${second} ${first}${third ? third.replace(',', '') : ''}`
  }

  // "September 8" form, optional year in group 2.
  return `${first}${second && /\d{4}/.test(second) ? second.replace(',', '') : ''}`
}

/**
 * Parses a date and rolls it into next year when the bare month/day has already passed.
 *
 * "back on January 5" read in December means next January, not the January eleven months
 * gone. Without this the date lands in the past, the horizon check rejects it, and the
 * reply silently takes the fallback despite naming a date.
 */
function parseWithYearRollover(candidate: string, now: Date): Date | null {
  const hasExplicitYear = /\d{4}/.test(candidate)
  const parsed = new Date(hasExplicitYear ? candidate : `${candidate} ${now.getUTCFullYear()}`)

  if (Number.isNaN(parsed.getTime())) return null

  const horizon = new Date(now.getTime() + OOO_MAX_HORIZON_DAYS * MS_PER_DAY)

  if (parsed > now && parsed <= horizon) return parsed

  if (!hasExplicitYear) {
    const nextYear = new Date(`${candidate} ${now.getUTCFullYear() + 1}`)
    if (!Number.isNaN(nextYear.getTime()) && nextYear > now && nextYear <= horizon) {
      return nextYear
    }
  }

  return null
}

/**
 * THE ONLY SUPPORTED ENTRY POINT. Always returns a resume time.
 *
 * Callers must never reach for parseOooReturnDate directly and write its null through to
 * scheduled_resume_at. That was the 2026-09-07 defect and this signature is what prevents
 * it: there is no way to obtain a null from this function.
 */
export function resolveOooResumeAt(body: string, now: Date = new Date()): OooResume {
  const parsed = parseOooReturnDate(body, now)

  if (parsed) {
    return { resumeAt: parsed.iso, source: 'parsed', matchedText: parsed.matchedText }
  }

  return {
    resumeAt: addBusinessDays(now, OOO_FALLBACK_BUSINESS_DAYS).toISOString(),
    source: 'fallback',
    matchedText: null,
  }
}
