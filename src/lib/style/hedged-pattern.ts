// A POSSIBILITY ABOUT FIRMS LIKE THE READER'S IS NOT A CLAIM ABOUT THE READER.
//
// ═════════════════════════════════════════════════════════════════════════════
// EXPERIMENT, 2026-10-01. On the 20-prospect first look, 13 fell to the template and in most
// of them the research fact was usable. What failed was the bridge: the writer has to say
// why the fact matters, the only sentences it had were flat statements, and a flat statement
// is either a claim about the reader (banned, correctly) or a claim about a market nobody
// measured (rejected by the fact-check, also correctly). There was no legal sentence left.
//
// The approved templates already solved this. A consequence there is said as a POSSIBILITY:
// "can", "often", "tends to". This file carries that same boundary to Email 1's bridge.
//
//   ALLOWED   "A podcast that builds credibility often does not book the next meeting."
//             About firms in that position, and hedged. True whether or not it is true of
//             this reader, which is the whole point.
//   A CLAIM   "Your podcast does not book the next meeting."
//             About the reader. Stays banned, hedged or not.
//   A CLAIM   "A podcast that builds credibility does not book the next meeting."
//             About a market, stated flat. Still goes to the fact-check as before.
//
// ═══ THE WORD LIST IS A SECOND COPY, AND THAT IS STATED RATHER THAN HIDDEN ═══
//
// The template rule lives in findAssertedConsequences, in
// src/lib/outbound-templates/validate-templates.ts ON THE firm-fact-tier BRANCH. That file
// is not on main, so this list cannot import it. If this experiment is ever merged after
// that branch, IMPORT THE PATTERN and delete this copy: two lists that must agree is the
// parallel-arrays shape, and the day they disagree a bridge passes here that a template
// would refuse.
//
// DETERMINISTIC, PER ADR-018. Whether a sentence carries a possibility word and whether it
// mentions the reader are both properties of the string.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The possibility words. "can", and not "can't": the apostrophe is a word boundary, so a
 * bare \bcan\b would read "sales can't recover" as a possibility.
 */
const POSSIBILITY = /\b(can(?!['’]t)|could|might|often|sometimes|usually|tend to|tends to|at times)\b/i

/** "may", and not the month: lower-case anywhere, capitalised only as the first word. */
const MAY = /\bmay\b|^May\b/

/** Any second-person word makes the sentence about the reader, wherever it sits. */
const READER = /\b(you|your|yours|yourself|yourselves)\b/i

/**
 * True when the sentence is a hedged statement about firms like the reader's, and says
 * nothing about the reader.
 *
 * ALL FOUR MUST HOLD, and each one closes a different door:
 *   not a question        a question asserts nothing and is checked on its own terms
 *   a possibility word    without it the sentence is a flat claim about a market
 *   no "you" or "your"    with it the sentence is about the reader, however it is hedged
 *   no company name       the same, by name
 *
 * `readerNames` is every form of the reader's company name the caller knows. A form of two
 * characters or fewer is ignored: it would match inside ordinary words.
 */
export function isHedgedPatternStatement(sentence: string, readerNames: readonly string[] = []): boolean {
  const text = (sentence ?? '').trim()
  if (!text) return false
  if (text.endsWith('?')) return false
  if (!POSSIBILITY.test(text) && !MAY.test(text)) return false
  if (READER.test(text)) return false
  const low = text.toLowerCase()
  if (readerNames.some(n => n.trim().length > 2 && low.includes(n.trim().toLowerCase()))) return false
  return true
}
