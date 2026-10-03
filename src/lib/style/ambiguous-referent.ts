// Indefinite referents: words that point at SOMEBODY without saying who.
//
// Operator rule, 2026-10-01 (reading file 2, note 3): no phrase that can be read two ways.
// The example was a pain line ending "good work can go to someone else". The writer meant a
// rival firm. A reader can as easily take it to mean a colleague down the corridor, and
// then the sentence is about office politics, not lost business.
//
// THIS IS THE FLOOR, NOT THE RULE. A list catches only what it names. Whether a phrase can
// be read two ways is a judgement, and the scope judge makes it per line (`ambiguous`).
// The list exists so the commonest case never depends on a model, and so a client's BRIEF
// can be refused for it: the phrase above was in the brief, and copy that repeats the
// brief's own words cannot be repaired by rewriting the copy.
//
// Generic English, no client or market wording (Rule Zero).

// The words that, straight after "others" or "other people", say who is meant: "others in
// your field", "others on your team", "other people who run a site like yours". One list
// for both, so the two cannot disagree.
const SAYS_WHO = '(?!\\s+(?:in|at|on|from|of|across|like|who|with|among)\\b)'

const PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\b(?:someone|somebody|anyone|anybody|everyone|everybody|no one|nobody|something|somewhere|anywhere)\s+else\b/i, 'name who or what is meant'],
  [/\belsewhere\b/i, 'name where'],
  // "others" with no noun after it: "go to others". "other firms" names them and is fine,
  // and so is "others in your field", which says who in the next three words.
  [new RegExp(`\\bothers\\b${SAYS_WHO}`, 'i'), 'say "other" plus who: other firms, other buyers'],
  // "other people" names nobody, exactly as "others" does, and is fine on the same terms.
  [new RegExp(`\\bother\\s+people\\b${SAYS_WHO}`, 'i'), 'say who: other firms, other buyers'],
  // A bare "someone" at the end of its clause: "work can go to someone." With a word after
  // it that says who ("someone on your team", "someone who knows the market") it is fine.
  [/\b(?:someone|somebody)\b(?=\s*[.,;:!?]|\s*$)/i, 'name who is meant'],
]

/** Every indefinite referent in the text, as the matched words. Empty when there are none. */
export function findAmbiguousReferents(text: string): string[] {
  const found: string[] = []
  for (const [pattern] of PATTERNS) {
    const match = text.match(pattern)
    if (match) found.push(match[0])
  }
  return found
}
