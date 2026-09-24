// Counts sentences in a short piece of writer copy, for the one-sentence bridge gate.
//
// A BREAK IS . ! ? ; OR : FOLLOWED BY WHITESPACE AND MORE TEXT. A closing quote or bracket
// between the mark and the space still counts. Semicolons and colons are breaks on purpose:
// they are how a second sentence gets past a count that only looks for full stops.
//
// NOT A BREAK: a mark with no space after it ("2.5", "9:30"), the full stop inside a common
// abbreviation ("e.g.", "Dr.", "Inc."), or a personal initial ("Katherine O. Brien"). Any of
// them would otherwise split one sentence in two and reject good copy, which costs the
// prospect a writer attempt and, when every attempt hits it, the whole email.
//
// WHAT IT CANNOT SEE, stated rather than discovered later: two ideas joined by a comma or a
// conjunction. That is not a sentence count, and no punctuation rule can find it.

const ABBREVIATIONS = [
  'e.g.', 'i.e.', 'etc.', 'vs.', 'Mr.', 'Mrs.', 'Ms.', 'Dr.', 'Prof.', 'St.', 'U.S.', 'U.K.',
  // COMPANY AND PERSON SUFFIXES, added 2026-09-24. An observation names a company and often
  // a person, and every one of these ended a "sentence" that had not ended.
  'Inc.', 'Ltd.', 'Co.', 'Corp.', 'plc.', 'LLC.', 'L.L.C.', 'GmbH.', 'S.A.', 'Pty.',
  'Jr.', 'Sr.', 'No.', 'Nos.', 'Dept.', 'Est.',
]

/**
 * A PERSONAL INITIAL: a single capital letter and a full stop, as in a middle initial or a
 * name written with initials.
 *
 * MEASURED 2026-09-24. Eight of nineteen prospects lost their email to the one-sentence
 * observation gate on every attempt, and the first one inspected was "You shared the news
 * that Brittney Nichols and Katherine O. Brien were promoted" counted as TWO sentences. The
 * copy was one sentence. The counter was wrong.
 *
 * It matters more now than it used to: the observation is where people are named, and the
 * reshare rule means it names them more often. The bridge gate has used this counter since
 * before the observation had one, so the same mis-split has been quietly costing attempts
 * wherever a bridge named a company with a suffix.
 *
 * A CAPITAL FOLLOWED BY A FULL STOP IS NEVER A SENTENCE END IN THIS COPY, because a
 * one-letter sentence does not exist.
 */
const INITIAL = /\b(\p{Lu})\.(?=\s|$)/gu

// ONE DOT LEADER. It looks like a full stop and is not one, so a protected abbreviation
// keeps its shape without being read as a break.
const PLACEHOLDER = '․'

export function countSentences(text: string): number {
  let t = text.trim()
  if (!t) return 0
  for (const a of ABBREVIATIONS) t = t.split(a).join(a.replace(/\./g, PLACEHOLDER))
  t = t.replace(INITIAL, (_m, letter: string) => `${letter}${PLACEHOLDER}`)
  return t
    .split(/(?<=[.!?;:]["'”’)\]]*)\s+(?=\S)/)
    .filter(part => /[\p{L}\p{N}]/u.test(part))
    .length
}
