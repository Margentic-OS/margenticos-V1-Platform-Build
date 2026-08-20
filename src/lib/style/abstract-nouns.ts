// Abstract nouns in customer-facing copy. REPORT ONLY, deliberately.
//
// WHY THIS IS NOT A GATE
// The bridges that shipped on 2026-08-20 passed every structural rule and still read as
// abstract: "That remainder tends to shrink before it grows", "The regions that come after
// tend to need a different engine". Nobody can picture a remainder, and an engine is a
// metaphor doing work a plain sentence should do. The reader has to translate the sentence
// into their own week before they can tell whether it is about them, and in an inbox they
// will not.
//
// The fix is in the prompt, with worked pairs. This exists to measure whether the fix held,
// which is a different job from enforcing it. Gating on a word list would reject "the
// engine room" and "cash flow" and any legitimate use, and the failure it targets is a
// matter of degree rather than a rule a regex can settle. So it counts and reports, and
// nothing acts on the number.
//
// Deterministic by design (ADR-018): matching words against a fixed list is counting.

/**
 * The named list, from the copy review of the 2026-08-20 batch. Deliberately closed and
 * short. Adding a word here changes a reported number, never a shipped decision.
 *
 * `load` and `output` are NOT here. Both are acceptable attached to something concrete
 * ("a real operational load") and weak only as a bare subject ("that output shows"), which
 * is a judgement no word list can make. They stay a matter for the prompt and the reader.
 */
export const ABSTRACT_NOUNS: readonly string[] = [
  'remainder',
  'engine',
  'momentum',
  'capacity',
  'bandwidth',
  'cadence',
  'motion',
  'flow',
]

export interface AbstractNounHit {
  noun: string
  count: number
}

/**
 * Every listed noun found in the text, with its count. Matches the singular and the plural
 * and is case-insensitive. Empty when the copy is concrete.
 */
export function findAbstractNouns(text: string): AbstractNounHit[] {
  if (!text) return []
  const hits: AbstractNounHit[] = []

  for (const noun of ABSTRACT_NOUNS) {
    // Plural only, not a general suffix match: "flows" counts, "flowing" and "engineer"
    // do not, because those are different words doing a different job.
    const pattern = new RegExp(`\\b${noun}s?\\b`, 'gi')
    const count = (text.match(pattern) ?? []).length
    if (count > 0) hits.push({ noun, count })
  }

  return hits
}

/** Total listed abstract nouns in the text. The single number worth watching per batch. */
export function countAbstractNouns(text: string): number {
  return findAbstractNouns(text).reduce((total, hit) => total + hit.count, 0)
}


// ─── Figurative verbs ────────────────────────────────────────────────────────
//
// The noun rule worked. Every noun in the 2026-08-20 batch was concrete and the abstraction
// simply moved into the verbs and the sentence endings: "those tend to shrink before they
// grow", "business development is the thing that moves when something has to", "tend to need
// a nudge before they become a conversation". Concrete nouns, unfilmable sentences.
//
// The rule is in the prompt as the camera test: point a camera at their week and ask whether
// you would see the thing described happening. An hour cannot shrink and a person cannot
// become a conversation. This counts the named offenders so the rule can be checked against
// real output instead of assumed to have worked.
//
// REPORT ONLY, for the same reasons as the nouns above, and more so. "The deadline moves" is
// literal and fine. "Business development moves" is not. No regex can separate those, and
// gating on the verb would reject correct copy.

/** The named list, from the copy review. Exactly the verbs called out, nothing invented. */
export const FIGURATIVE_VERBS: readonly string[] = [
  'move',
  'shrink',
  'become',
  'convert',
  'translate',
  'materialise',
  'materialize',
]

export interface FigurativeVerbHit {
  verb: string
  count: number
}

/**
 * Every listed verb found, with its count. Matches the ordinary inflections (-s, -ing, -ed,
 * and the irregular "became"), case-insensitively.
 *
 * Deliberately does NOT match nouns built from the same stem: "the move", "a convert".
 * Those are things rather than actions and are not what this measures.
 */
export function findFigurativeVerbs(text: string): FigurativeVerbHit[] {
  if (!text) return []
  const hits: FigurativeVerbHit[] = []

  for (const verb of FIGURATIVE_VERBS) {
    const stem = verb.replace(/e$/, '')
    const forms = [verb, `${verb}s`, `${stem}ing`, `${stem}ed`, `${verb}d`]
    if (verb === 'become') forms.push('became', 'becoming')
    const pattern = new RegExp(`\\b(?:${[...new Set(forms)].join('|')})\\b`, 'gi')
    const count = (text.match(pattern) ?? []).length
    if (count > 0) hits.push({ verb, count })
  }

  return hits
}

/** Total listed figurative verbs in the text. */
export function countFigurativeVerbs(text: string): number {
  return findFigurativeVerbs(text).reduce((total, hit) => total + hit.count, 0)
}
