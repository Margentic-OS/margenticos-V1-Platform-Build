// PARSING A FINDING'S DATE, AND REFUSING TO GUESS AT ONE.
//
// ═════════════════════════════════════════════════════════════════════════════
// ITS OWN MODULE, WITH NO IMPORTS, AND THAT IS DELIBERATE. This lives here rather than in
// relative-time.ts because synthesize.ts needs it too, and relative-time.ts already imports
// contentOverlap FROM synthesize.ts. Importing back would close a cycle, and a cycle in this
// codebase passes `tsc --noEmit` and the whole vitest suite and fails only `npm run build`.
// A file with no dependencies cannot be half of one.
//
// WHY IT REFUSES WHAT new Date() WOULD ACCEPT. Handing a free-text date to new Date() does
// not fail loudly; it guesses, and the guess can be years out. Measured 2026-09-30:
//
//     new Date("September 12-17, 2026")  ->  2017-09-12
//
// It reads the "-17" as the year and discards the 2026. One prospect's chosen finding carries
// exactly that string, so copy correctly saying "last month" about a September burst was
// measured against an event nine years old and reported as 108 MONTHS out. The copy was
// right, the gate was wrong, and wrong in the direction that costs a personalised email.
//
// A DATE THAT LOOKS PARSEABLE AND IS NOT is worse than one that plainly is not: it produces a
// confident wrong answer instead of a fail-open.

/** The shapes we write, and the only ones accepted: YYYY, YYYY-MM, YYYY-MM-DD, plus a time. */
const ISO_SHAPE = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?(?:[T\s].*)?$/

/** True when the string is a date we can reason about. Used to sort ISO from prose. */
export function isMachineReadableDate(date: string | null | undefined): boolean {
  return parseFindingDate(date) !== null
}

/**
 * A finding's date, or null.
 *
 * NULL FOR ANYTHING OUTSIDE THE ISO SHAPES, including every prose form synthesis has been
 * observed to produce: "approximate: August-September 2026", "ongoing since 2018-02-01",
 * "approximate: roles ended Apr 2025 and Mar 2026". Every caller already handles null by
 * leaving the sentence alone, which is the correct answer for a date nobody can read.
 */
export function parseFindingDate(date: string | null | undefined): Date | null {
  if (!date) return null
  const m = String(date).trim().match(ISO_SHAPE)
  if (!m) return null
  const d = new Date(`${m[1]}-${m[2] ?? '01'}-${m[3] ?? '01'}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? null : d
}
