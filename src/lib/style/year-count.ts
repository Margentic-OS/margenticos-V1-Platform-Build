// A COUNT OF YEARS IS ARITHMETIC. THE MODEL MUST NOT DO IT.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE 2026-09-24 MEASUREMENT. One prospect's firm was founded in September 2012. His
// Email 1 SUBJECT said twelve years, his Email 3 said thirteen. It was fourteen. Both
// numbers were written by a model reading a date and counting in prose, and the correct
// figure existed on the same database row the whole time.
//
// Two numbers, one prospect, one run, and neither right. A wrong duration is worse than no
// duration: it is checkable by the reader in one second, it is about THEIR OWN business,
// and it says the sender did not look properly.
//
// DETERMINISTIC, PER ADR-018. Subtracting two dates is not a judgement. There is nothing
// here an LLM does better, and a prompt instruction would be advisory against a model that
// is already reciting a date it half-remembers.
//
// WHAT THIS GATE ASSERTS, and it is deliberately narrow: a number of years stated in copy
// must equal the elapsed time since a date THE FINDINGS CARRY. It does not invent a
// duration, does not rewrite one, and does not ban the construction. A correct count still
// ships, which matters because "fourteen years running it solo" is good copy when true.
//
// A COUNT WITH NO DATE BEHIND IT IS REJECTED, not reported. That is the whole rule: if the
// code cannot source the figure, the model made it up, and "never by the model" is the
// instruction. The alternative, passing an unverifiable number, is how both wrong figures
// shipped.

/** Spelled-out counts, as far as any real duration in this copy goes. */
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
}

/**
 * Every explicit count of YEARS in the text, as written and as a number.
 *
 * NUMERALS AND WORDS BOTH, because the two wrong figures of 2026-09-24 were "12" in a
 * subject line and "Thirteen" in a body, and a rule that saw only one of them would have
 * caught one of the two.
 *
 * VAGUE DURATIONS ARE NOT COUNTS and are left alone: "over a decade", "for years", "a long
 * time". They make no checkable claim, so there is nothing to be wrong about, and gating
 * them would be banning a construction rather than enforcing arithmetic.
 */
export function findYearCounts(text: string): Array<{ phrase: string; years: number }> {
  const out: Array<{ phrase: string; years: number }> = []
  const re = /\b(\d{1,2}|[a-z]+)[\s-]+years?\b/gi
  for (const m of text.matchAll(re)) {
    const raw = m[1].toLowerCase()
    const years = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw]
    if (years === undefined || years === 0) continue
    out.push({ phrase: m[0], years })
  }
  return out
}

/**
 * Whole years between a stored date and the run date, or null when the date carries no year.
 *
 * FLOORED, because that is how a person counts: a firm founded in September 2012 is
 * "fourteen years old" from its fourteenth September, not from the July before it.
 */
export function elapsedYears(date: string | null | undefined, now: Date): number | null {
  if (!date) return null
  const parsed = new Date(String(date).length === 4 ? `${date}-01-01` : String(date))
  if (Number.isNaN(parsed.getTime())) return null
  let years = now.getUTCFullYear() - parsed.getUTCFullYear()
  const beforeAnniversary =
    now.getUTCMonth() < parsed.getUTCMonth() ||
    (now.getUTCMonth() === parsed.getUTCMonth() && now.getUTCDate() < parsed.getUTCDate())
  if (beforeAnniversary) years -= 1
  return years < 0 ? null : years
}

/** True when a stored date names a year and nothing narrower. */
function isYearOnly(date: string): boolean {
  return /^\s*(19|20)\d{2}\s*$/.test(date)
}

/**
 * Counts of years the FINDINGS TEXT states outright, rather than implying by a date.
 *
 * Two shapes, both measured on real findings of 2026-09-24:
 *   "a 19-year anniversary piece"      -> 19, stated directly
 *   "on a supplier directory for 2023, 2024, and 2025" -> 3, an ENUMERATION whose length is the count
 *
 * The enumeration needs two or more years listed together, separated only by commas and
 * "and". Counting every four-digit year anywhere in the findings would let an unrelated run
 * of dates admit any small number, which is the false-positive direction.
 */
function countsStatedInFindings(findingsText: string): Set<number> {
  const stated = new Set<number>()
  for (const { years } of findYearCounts(findingsText)) stated.add(years)
  for (const m of findingsText.matchAll(/(?:(?:19|20)\d{2})(?:\s*(?:,|,?\s*and)\s*(?:19|20)\d{2})+/gi)) {
    const distinct = new Set((m[0].match(/(19|20)\d{2}/g) ?? []))
    if (distinct.size >= 2) stated.add(distinct.size)
  }
  return stated
}

/**
 * How near a stated count has to be to a computed one before the COMPUTED one wins.
 *
 * ─── THE CASE THIS NUMBER EXISTS FOR ────────────────────────────────────────
 *
 * A findings text can state a duration AND be stale, and then the date beside it is right
 * and the sentence is wrong. Measured 2026-09-24: one prospect's findings said "for over 13
 * years" and "a 13-year-old firm", and carried the founding date 2012-09-01, from which the
 * answer on the run date was FOURTEEN. Admitting a stated count unconditionally would have
 * shipped the stale figure, which is the whole defect.
 *
 * But arithmetic cannot simply win either. Another prospect's findings said "a 19-year
 * anniversary piece" on a post dated 2026-09-16, and the elapsed time from THAT date is
 * zero: the date is when the post went up, the 19 is what the post is about. The code
 * cannot tell a start date from a publication date.
 *
 * WHAT IT CAN TELL is whether the two numbers are describing the same thing. A stated count
 * within a year of a computed one is the same duration said staler, and the arithmetic is
 * the better answer. A stated count nowhere near any computed one is a different claim the
 * findings assert outright, and there is no arithmetic to prefer.
 */
const SAME_CLAIM_TOLERANCE = 1

/**
 * Every year count in the copy that the findings do not support.
 *
 * SUPPORTED, in order of authority:
 *   1. it equals the elapsed time from a dated finding and the run date. A date carrying
 *      only a year admits the value either side too, because the anniversary within that
 *      year is unknown and both answers are honest.
 *   2. it equals a count the findings state outright, or the length of a year enumeration
 *      they list, UNLESS a computed value sits within SAME_CLAIM_TOLERANCE of it, in which
 *      case the computed value is the same claim said more accurately and wins.
 *
 * MATCHED AGAINST THE WHOLE CANDIDATE LIST, not one selected candidate. Same lesson the
 * event-year gate learned the same day: the writer chooses which finding to describe, so a
 * gate keyed to one candidate demands a figure about an event the copy never mentions.
 */
export function findYearCountFaults(
  text: string,
  candidates: ReadonlyArray<{ date?: string | null; observation?: string | null }>,
  now: Date,
  findingsText?: string,
): string[] {
  const counts = findYearCounts(text)
  if (counts.length === 0) return []

  // TWO SETS, AND THE DIFFERENCE BETWEEN THEM IS LOAD-BEARING.
  //
  //   computed          every value the findings can justify, INCLUDING the slack a
  //                     year-only date earns. Used to ADMIT a count.
  //   computedPrecise   only values from a date with a month behind it. Used to OVERRIDE a
  //                     figure the findings state.
  //
  // A YEAR-ONLY DATE IS A RANGE, not a day: "2025" could be January or December, so the
  // elapsed count is one of two whole numbers and both are honest. That slack must widen
  // what is allowed and must never narrow it. Measured 2026-09-24: with one set, a year-only
  // finding of "2025" admitted 0, 1 and 2, and a findings-stated count of THREE then sat
  // within the override tolerance of 2 and was rejected, on the authority of a date that
  // does not know its own month. An imprecise value cannot be the reason a stated one loses.
  const computed = new Set<number>()
  const computedPrecise = new Set<number>()
  for (const c of candidates) {
    const n = elapsedYears(c.date, now)
    if (n === null) continue
    computed.add(n)
    if (c.date && isYearOnly(String(c.date))) {
      computed.add(n + 1)
      if (n > 0) computed.add(n - 1)
    } else {
      computedPrecise.add(n)
    }
  }

  const corpus = findingsText ?? candidates.map(c => c.observation ?? '').join(' ')
  const stated = countsStatedInFindings(corpus)

  const faults: string[] = []
  for (const { phrase, years } of counts) {
    if (computed.has(years)) continue
    const nearComputed = [...computedPrecise].some(n => Math.abs(n - years) <= SAME_CLAIM_TOLERANCE)
    if (stated.has(years) && !nearComputed) continue

    const truth = [...computed].sort((a, b) => a - b)
    faults.push(
      nearComputed
        ? `"${phrase}" disagrees with the dates in the findings, which give ${truth.join(' or ')}: ` +
          'the findings prose carries a stale figure and the date beside it is the reliable one'
        : truth.length > 0
          ? `"${phrase}" matches no date and no figure in the findings, which give ${truth.join(' or ')}: ` +
            'state a figure the findings support, or drop the count and name the event instead'
          : `"${phrase}" is a count of years with no dated finding behind it: ` +
            'drop it, because a duration the research cannot source is a guess the reader can check',
    )
  }
  return faults
}
