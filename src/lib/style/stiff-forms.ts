// Two words written out where a person writing an email would contract them.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE RULE (operator note 3 on the fourth reading, 2026-10-02)
//
// "Human tone: contractions allowed everywhere; break-up emails read like a person ('No
// worries if now's not the time...'), never 'It is fine if this is not a fit right now.'"
//
// The line he refused is stiff for one reason a list can hold: "It is" and "is not" are
// written out. Every template until then avoided contractions, on a rule nobody had
// written down, and read like a form letter for it.
//
// So this names the pairs. It is a FLOOR: it catches the written-out pair, which is the
// plainest mark of a stiff line, and it cannot tell a warm line from a cold one. Whether a
// break-up "reads like a person" beyond that is the generator's instruction and the
// operator's read.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHERE IT IS APPLIED
//
// On the AUTHORED words of every template email, slots masked. A prospect's own clause
// ("you are an HR consultancy") is their page's wording and is not held to it.
//
// NOT at the end of a sentence or before a comma: "as it is." and "if it is, ..." do not
// contract in English.

export const PAIRS: ReadonlyArray<[RegExp, string]> = [
  [/\bit is\b/i, "it's"],
  [/\bthat is\b/i, "that's"],
  [/\bthere is\b/i, "there's"],
  [/\bhere is\b/i, "here's"],
  [/\bwhat is\b/i, "what's"],
  [/\bi am\b/i, "I'm"],
  [/\bwe are\b/i, "we're"],
  [/\byou are\b/i, "you're"],
  [/\bthey are\b/i, "they're"],
  [/\bwe have\b(?=\s+(?:been|got|seen|found|heard|worked|helped|built|learned|learnt)\b)/i, "we've"],
  [/\bwe will\b/i, "we'll"],
  [/\byou will\b/i, "you'll"],
  [/\bis not\b/i, "isn't"],
  [/\bare not\b/i, "aren't"],
  [/\bwas not\b/i, "wasn't"],
  [/\bwere not\b/i, "weren't"],
  [/\bdo not\b/i, "don't"],
  [/\bdoes not\b/i, "doesn't"],
  [/\bdid not\b/i, "didn't"],
  [/\bcannot\b/i, "can't"],
  [/\bcan not\b/i, "can't"],
  [/\bwill not\b/i, "won't"],
  [/\bwould not\b/i, "wouldn't"],
  [/\bcould not\b/i, "couldn't"],
  [/\bshould not\b/i, "shouldn't"],
  [/\bhas not\b/i, "hasn't"],
  [/\bhave not\b/i, "haven't"],
  // NOT "let us". "Let us know" does not contract, and "let's" is a different sentence: an
  // invitation to do something together, where "let us" asks leave. The pair was listed
  // until 2026-10-02 and told the writer to turn "let us know" into "let's know", which
  // then passed every check.
]

/** "what it is that ...", "who we are before ...": inside a wh-clause the pair does not contract. */
const WH_BEFORE = /\b(?:what|who|where|how|why|which|whatever|whoever|wherever)\s+$/i

export interface StiffForm {
  /** The words as written. */
  found: string
  /** How a person writes them. */
  write: string
}

/** Every written-out pair in the text that a person would contract, in order of the list. */
export function findStiffForms(text: string): StiffForm[] {
  const out: StiffForm[] = []
  const normalised = text.replace(/[‘’ʼ]/g, "'")
  for (const [pattern, write] of PAIRS) {
    const global = new RegExp(pattern.source, 'gi')
    for (const m of normalised.matchAll(global)) {
      const after = normalised.slice((m.index ?? 0) + m[0].length)
      // Sentence-final or clause-final: "as it is.", "if it is, we ..." do not contract.
      if (/^\s*(?:[.,;:!?)]|$)/.test(after)) continue
      // "what it is that slows pay runs": the wh-word owns the pair.
      if (!/^what is$/i.test(m[0]) && WH_BEFORE.test(normalised.slice(0, m.index ?? 0))) continue
      // A question that inverts keeps its words apart: "What is it?" is caught as "what is",
      // and that one does contract ("What's it ..."), so it is left in.
      out.push({ found: m[0], write })
    }
  }
  return out
}
