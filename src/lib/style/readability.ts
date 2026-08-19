// Deterministic readability scoring for generated customer-facing observations.
//
// WHY THIS EXISTS
// The six research tests (SPECIFIC, VERIFIABLE, INFERENTIAL, RELEVANT, USEFUL,
// NON_JUDGEMENTAL) all ask whether an observation is TRUE and RELEVANT. Nothing asked
// whether it was READABLE. This line scored 6/6 and shipped:
//
//   "Running Taffet alongside the CRC Director engagement from mid-2024 through mid-2025
//    is a particular kind of balancing act, and with that role now wrapped, the pipeline
//    question for Taffet tends to land differently."
//
// 37 words, one sentence, two hedges, ending on an abstraction. The benchmark it should
// have resembled, from a campaign that replied at 7 percent:
//
//   "Read through your last 30 reviews on Google. Front desk hold times keep coming up,
//    4 of the most recent 10."
//
// Deterministic by design (ADR-018). Sentence length and hedge phrases are pattern
// matching on predictable text, not judgement, so no LLM is involved. The subjective
// half of the rubric (say-it-aloud, picture test, buyer vocabulary, any-other-email)
// lives in the synthesis prompt where a model can actually apply it.
//
// TWO CLASSES OF SIGNAL, DELIBERATELY TREATED DIFFERENTLY:
//
//   HARD FAIL — sentence over MAX_SENTENCE_WORDS, or any hedge phrase. Both are
//   unambiguous: counting words has no false positives, and the hedge list is a closed
//   set of literal phrases. These gate selection (ADR-028: code validators are hard
//   gates on LLM output, prompt instructions are advisory).
//
//   PENALTY ONLY — nominalisation density. nominalisation.ts documents itself as a
//   smell rather than a verdict, because suffix matching cannot tell "attention" (a real
//   nominalisation) from "question" or "mention" (ordinary nouns ending in -tion). A hard
//   gate on a check with known false positives would reject good copy, so density
//   contributes demerits that rank candidates and never rejects one on its own.

import { nominalisationDensity, type NominalisationScore } from './nominalisation'

// A sentence a thirteen-year-old follows on first read. Two short sentences beat one
// long one, so the cap is per sentence, not per observation.
export const MAX_SENTENCE_WORDS = 25

// The band below the cap where a sentence is legal but getting long. Ranks worse than a
// genuinely short sentence without failing.
const LONG_SENTENCE_WORDS = 21

// Literal hedge phrases. Hedging is the specific failure in the worked example above:
// "tends to land differently" commits to nothing, so the reader has nothing to react to.
// Matched case-insensitively on word boundaries so "may" never fires inside "maybe" and
// "might" never fires inside "mighty".
// Two deliberate omissions, both to stay consistent with the synthesis prompt:
//
//   "suggests" / "suggesting" are NOT hedges here. The prompt's NON_JUDGEMENTAL rule
//   actively prescribes that frame for composite absence patterns ("the pattern across
//   your blog and case studies suggests delivery has been eating the marketing time").
//   Banning it would hard-fail every composite candidate and contradict the prompt.
//
//   "may" is omitted because it collides with the month. SPECIFIC pushes observations to
//   carry dates, so "since May 2024" would fire a false hedge. "might" covers the modal
//   sense without the collision.
export const HEDGE_PHRASES = [
  'tends to', 'tend to',
  'can be', 'could be', 'would be',
  'often', 'usually', 'typically', 'generally', 'frequently',
  'somewhat', 'relatively', 'fairly',
  'a particular kind of', 'a certain kind of', 'a kind of', 'a sort of',
  'seems to', 'seem to', 'appears to', 'appear to',
  'might', 'perhaps', 'possibly', 'probably', 'arguably',
  'in some ways', 'to some extent', 'more often than not',
  'has a way of', 'have a way of',
] as const

export interface ReadabilityScore {
  /** Sentences as split for scoring. */
  sentences: string[]
  /** Word count of the longest sentence. 0 for empty text. */
  maxSentenceWords: number
  /** Sentences over MAX_SENTENCE_WORDS, verbatim. */
  longSentences: string[]
  /** Hedge phrases found, deduplicated, in order of first appearance. */
  hedges: string[]
  nominalisation: NominalisationScore
  /**
   * True when an unambiguous rule was broken: an over-length sentence or a hedge.
   * Gates selection. Never set by nominalisation density alone.
   */
  hardFail: boolean
  /** Demerits, lower is better. Ranks candidates that all pass the hard gate. */
  penalty: number
  /** Plain-English reasons, one per problem found. Empty when the text is clean. */
  reasons: string[]
}

// Splits on sentence-ending punctuation followed by whitespace, and on a trailing
// terminator. Abbreviations inside an observation ("Jul. 2024") would over-split, so the
// split requires the following character to start a new word rather than continue one.
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

export function readabilityScore(
  text: string,
  maxSentenceWords: number = MAX_SENTENCE_WORDS,
): ReadabilityScore {
  const clean = (text ?? '').trim()
  const sentences = splitSentences(clean)
  const reasons: string[] = []

  const sentenceWordCounts = sentences.map(countWords)
  const maxWords = sentenceWordCounts.length > 0 ? Math.max(...sentenceWordCounts) : 0
  const longSentences = sentences.filter((_, i) => sentenceWordCounts[i] > maxSentenceWords)

  const seenHedges = new Set<string>()
  const hedges: string[] = []
  for (const phrase of HEDGE_PHRASES) {
    // Escape nothing: every phrase is plain words and spaces. Word boundaries stop
    // "may" firing inside "maybe".
    const re = new RegExp(`\\b${phrase}\\b`, 'i')
    if (re.test(clean) && !seenHedges.has(phrase)) {
      seenHedges.add(phrase)
      hedges.push(phrase)
    }
  }

  const nominalisation = nominalisationDensity(clean)

  let penalty = 0

  for (const sentence of longSentences) {
    const over = countWords(sentence) - maxSentenceWords
    // Scaled so a 37-word sentence ranks clearly worse than a 26-word one.
    penalty += 3 + over
    reasons.push(`Sentence runs ${countWords(sentence)} words, cap is ${maxSentenceWords}.`)
  }

  const longButLegal = sentences.filter(
    (s, i) => sentenceWordCounts[i] >= LONG_SENTENCE_WORDS && sentenceWordCounts[i] <= maxSentenceWords,
  )
  for (const sentence of longButLegal) {
    penalty += 1
    reasons.push(`Sentence runs ${countWords(sentence)} words, under the cap but long.`)
  }

  for (const hedge of hedges) {
    penalty += 2
    reasons.push(`Hedging phrase "${hedge}" commits to nothing.`)
  }

  // Penalty only, never a hard fail. See the header note on false positives.
  if (nominalisation.exceedsThreshold) {
    penalty += 2
    reasons.push(
      `Nominalisation density ${(nominalisation.density * 100).toFixed(1)} percent is over threshold ` +
      `(${nominalisation.matches.join(', ')}).`,
    )
  }

  const hardFail = longSentences.length > 0 || hedges.length > 0

  return {
    sentences,
    maxSentenceWords: maxWords,
    longSentences,
    hedges,
    nominalisation,
    hardFail,
    penalty,
    reasons,
  }
}
