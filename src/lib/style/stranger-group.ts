// DEFINING A GROUP BY WHAT IT DOES NOT KNOW IS NOT A CLAIM ABOUT THE MARKET.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE DISTINCTION, AS THE OPERATOR SET IT. Two sentences that share almost every word:
//
//   ALLOWED   "Buyers who have never heard of <firm> won't find this on their own."
//   A CLAIM   "Buyers have not heard of <firm> yet."
//
// The first DEFINES a group and says what that group will not do. It is true by
// construction: whoever those people are, they cannot find something they do not know about.
// Nothing has to be established about the market for it to hold, and the sentence is still
// true if the group is empty.
//
// The second ASSERTS A PRESENT STATE OF AWARENESS across a market nobody has measured. It
// needs a finding and there will never be one.
//
// WHY IT HAD TO BE ENCODED. The Email 1 fact-check rejects both. Measured on 2026-09-28:
// five prospects were templated on stranger lines, four on the asserting form and ONE on the
// permitted form. That one is a false positive, and the permitted form is the most common
// bridge in the corpus, so the error rate here is not the error rate on a rare shape.
//
// ═══ THE SYNTAX IS THE WHOLE TEST, AND IT IS NARROW ═══
//
// Two things must both be true: the not-knowing sits inside a RELATIVE CLAUSE that defines
// the group, and the main clause is a MODAL about future behaviour. Either alone is not
// enough:
//
//   "Buyers who have never heard of us are the ones we want"   <- relative clause, no modal.
//                                                                 Asserts who they are.
//   "Buyers won't find this on their own"                      <- modal, no defining clause.
//                                                                 Asserts about all buyers.
//
// Requiring both is what keeps this from becoming a licence for any sentence with "never
// heard" in it, which is the shape it would otherwise excuse.

import { NEVER_HEARD } from './activity-verdict'

/** A relative pronoun introducing the clause that defines the group. */
const RELATIVE = /\b(who|whom|that|which)\b/i

/**
 * A modal about FUTURE behaviour. Present-tense states are deliberately absent: "are not
 * reading" and "do not know" assert how things stand, which is the form this does not cover.
 */
const FUTURE_MODAL =
  /\b(won'?t|will\s+not|will\s+never|cannot|can'?t|could\s+not|couldn'?t|are\s+not\s+going\s+to|is\s+not\s+going\s+to|never\s+will|would\s+not|wouldn'?t|are\s+unlikely\s+to|is\s+unlikely\s+to)\b/i

/**
 * True when the sentence defines a group by what it does not know and then says what that
 * group will not do.
 *
 * ORDER MATTERS AND IS CHECKED. The not-knowing has to sit AFTER the relative pronoun, or
 * "Buyers have not heard of us, which means they won't find this" would qualify: that is the
 * asserting form with a modal bolted on, and the relative clause there is about the
 * consequence rather than about the group.
 */
export function isStrangerGroupStatement(sentence: string): boolean {
  const text = (sentence ?? '').trim()
  if (!text) return false

  const rel = text.search(RELATIVE)
  if (rel < 0) return false

  const after = text.slice(rel)
  if (!NEVER_HEARD.test(after)) return false

  // The modal may sit either side of the defining clause: "Buyers who have never heard of us
  // won't find this" and "It won't reach buyers who have never heard of us" are the same
  // sentence with the clauses swapped, and both are the permitted shape.
  return FUTURE_MODAL.test(text)
}
