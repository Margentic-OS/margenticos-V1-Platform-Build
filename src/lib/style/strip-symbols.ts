/**
 * TRADEMARK, REGISTERED AND COPYRIGHT SYMBOLS, REMOVED FROM EVERYTHING THAT SHIPS.
 *
 * WHY. A cold email carrying "Reach Equity™" reads as marketing copy pasted from a brochure,
 * which is exactly the register this system's ICP was burned by. Nobody writing to a person
 * they have never met types a trademark symbol. Measured on the 104 cohort on 2026-09-25:
 * four prospects carried one, three of them inside the generated Email 1 and its subject line.
 *
 * THEY COME FROM TWO PLACES, and a fix that only knows about one misses the other:
 *   - the FINDINGS, when the research quotes a product or framework name the prospect
 *     trademarked: "You published a complete guide to Reach Equity™ on September 13"
 *   - the COMPANY NAME itself, stored with the symbol attached: "Focus & Find®"
 *
 * THE SECOND IS WHY MATCHING MUST STRIP TOO, not just the outgoing text. companyNameForms
 * builds the variants every gate compares against, so a company stored as "Focus & Find®"
 * produced forms nothing in the copy could match: the writer writes "Focus & Find", the gate
 * looks for "Focus & Find®", and every rule keyed on the company name silently stops firing
 * for that prospect. That is the quiet half of this fault and the reason the strip belongs in
 * one shared function rather than at the end of the composition pipeline alone.
 *
 * SERVICE MARK IS INCLUDED for the same reason as the other three. The emoji and other
 * decoration a company may carry in its name are deliberately NOT touched: they are not a
 * register problem, removing them would change a name rather than tidy it, and one prospect
 * in the same cohort has a company name ending in an emoji that is genuinely part of it.
 */
const SYMBOLS = /[™®©℠]/g

/**
 * Remove the symbols and tidy the space they leave behind.
 *
 * A symbol sits tight against the word before it, so removing it alone is enough in the
 * common case. Where it was followed by punctuation or sat between words, the collapse keeps
 * the result from carrying a double space that no writer would have typed.
 */
export function stripSymbols(text: string): string {
  if (!text) return text
  return text.replace(SYMBOLS, '').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([.,;:!?])/g, '$1')
}

/**
 * True when the text carries one, so a caller can report rather than silently clean.
 *
 * ITS OWN NON-GLOBAL REGEX, deliberately. `SYMBOLS` carries /g, and RegExp.test on a global
 * regex advances lastIndex and resumes from there on the next call, so a shared instance
 * returns true, then false, then true for the same input. A detector that alternates is worse
 * than no detector.
 */
const SYMBOL_PRESENT = /[\u2122\u00AE\u00A9\u2120]/

export function hasSymbols(text: string | null | undefined): boolean {
  return !!text && SYMBOL_PRESENT.test(text)
}
