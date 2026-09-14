// Counts sentences in a short piece of writer copy, for the one-sentence bridge gate.
//
// A BREAK IS . ! ? ; OR : FOLLOWED BY WHITESPACE AND MORE TEXT. A closing quote or bracket
// between the mark and the space still counts. Semicolons and colons are breaks on purpose:
// they are how a second sentence gets past a count that only looks for full stops.
//
// NOT A BREAK: a mark with no space after it ("2.5", "9:30"), and the full stop inside a
// common abbreviation ("e.g.", "Dr."). Either would otherwise split one sentence in two and
// reject a good bridge, which costs the prospect a writer attempt.
//
// WHAT IT CANNOT SEE, stated rather than discovered later: two ideas joined by a comma or a
// conjunction. That is not a sentence count, and no punctuation rule can find it.

const ABBREVIATIONS = ['e.g.', 'i.e.', 'etc.', 'vs.', 'Mr.', 'Mrs.', 'Ms.', 'Dr.', 'St.', 'U.S.', 'U.K.']

// ONE DOT LEADER. It looks like a full stop and is not one, so a protected abbreviation
// keeps its shape without being read as a break.
const PLACEHOLDER = '․'

export function countSentences(text: string): number {
  let t = text.trim()
  if (!t) return 0
  for (const a of ABBREVIATIONS) t = t.split(a).join(a.replace(/\./g, PLACEHOLDER))
  return t
    .split(/(?<=[.!?;:]["'”’)\]]*)\s+(?=\S)/)
    .filter(part => /[\p{L}\p{N}]/u.test(part))
    .length
}
