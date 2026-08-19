// Abstract nominalisation density: a deterministic readability signal for generated copy.
//
// A nominalisation is a noun built out of a verb or an adjective: "visibility" from
// "visible", "conversion" from "convert", "engagement" from "engage", "consistency" from
// "consistent". They let a sentence gesture at an idea without stating who does what to
// whom, which is exactly the failure mode in a line like "the pipeline question for
// Taffet tends to land differently". Cold email copy that a stranger reads in two seconds
// should be almost free of them.
//
// Deterministic by design (ADR-018). This is suffix matching on predictable text, not a
// judgement call, so no LLM is involved.
//
// REPORT ONLY. This never gates generation and never fails a build. An over-threshold
// score is logged for a human to look at. Suffix matching cannot tell "attention" (a
// genuine nominalisation) from "mention" or "question" (ordinary nouns that happen to end
// in -tion), so a hard gate on this would reject good copy. Treat the score as a smell,
// not a verdict.

// Density above which the copy is flagged. 4 percent means roughly one nominalisation
// per 25 words: about one per short paragraph. Cold email that reads aloud naturally
// lands well under this. Chosen as a starting threshold and tunable once there is a
// corpus of approved documents to calibrate against.
export const NOMINALISATION_THRESHOLD = 0.04

// Suffixes that reliably mark a noun built from a verb or adjective, with their plurals.
const NOMINALISATION_SUFFIXES = [
  'tions', 'tion',
  'ments', 'ment',
  'ities', 'ity',
  'encies', 'ency',
]

// Short common words that end in a listed suffix but are not abstract nominalisations.
// Kept deliberately small: the score is a smell, and over-tuning the exclusion list would
// hide the very vagueness the check exists to surface.
const EXCLUSIONS = new Set([
  'question', 'questions',
  'mention', 'mentions',
  'moment', 'moments',
  'city', 'cities',
  'quantity', 'quantities',
])

export interface NominalisationScore {
  /** Nominalisations divided by total words. 0 when the text has no words. */
  density: number
  /** Count of matched nominalisations. */
  count: number
  /** Total words considered. */
  totalWords: number
  /** The matched words, deduplicated, in order of first appearance. */
  matches: string[]
  exceedsThreshold: boolean
}

export function nominalisationDensity(
  text: string,
  threshold: number = NOMINALISATION_THRESHOLD,
): NominalisationScore {
  const words = text
    .toLowerCase()
    .replace(/\{\{[^}]+\}\}/g, ' ')      // merge tags are not prose
    .split(/[^a-z']+/)
    .filter(w => w.length > 0)

  const matches: string[] = []
  const seen = new Set<string>()

  for (const word of words) {
    if (EXCLUSIONS.has(word)) continue
    // Require some stem before the suffix so "ity" or "tion" alone never counts.
    const hit = NOMINALISATION_SUFFIXES.some(s => word.endsWith(s) && word.length > s.length + 2)
    if (!hit) continue
    matches.push(word)
    seen.add(word)
  }

  const totalWords = words.length
  const density = totalWords === 0 ? 0 : matches.length / totalWords

  return {
    density,
    count: matches.length,
    totalWords,
    matches: [...seen],
    exceedsThreshold: density > threshold,
  }
}
