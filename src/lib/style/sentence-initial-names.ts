// Catches a NAME at the start of a sentence, where capitalisation proves nothing.
//
// ─── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
//
// untraceableClaims in write-opening.ts requires every capitalised word in the writer's
// block to appear in the findings. Capitalisation is its evidence that a word is a name.
// It has three exemptions, and the third is a hole:
//
//     if (clean.length < 3) return
//     if (i === 0) return
//     if (i > 0 && /[.!?]$/.test(words[i - 1])) return     // <- this one
//
// That exemption is correct in isolation. The first word of a sentence is capitalised by
// convention, so its capital says nothing, and checking it would reject every ordinary
// word that opens a sentence.
//
// It is a hole because of WHERE the gate runs. Production calls it on `${opening}
// ${question}`, where opening is joinOpening(observation, bridge). The observation ends in
// a full stop, so the bridge's first token is ALWAYS sentence-initial. That is structural,
// not probabilistic. It is true on every call.
//
// The exempt set is bigger than the bridge alone. Splitting the whole block on whitespace
// leaves THREE guaranteed exempt positions, plus one for every sentence break inside any
// part:
//
//     index 0                the observation's first word
//     after the observation  the bridge's first word
//     after the bridge       the question's first word
//
// ─── MEASURED, 2026-08-28 ────────────────────────────────────────────────────
//
// The bridge is where the writer prompt's worked examples land, and those examples carry
// sixteen real named entities. Placed sentence-initially and run through the real exported
// checkOpeningGates with findings that do not contain them, TWELVE OF SIXTEEN LEAK.
//
// The four that are caught are caught incidentally, by a tail token that is not itself
// sentence-initial: Blue SKY, Hollywood FOOD COALITION, Stanford GSB, Knot CONSULTING.
// "Sovern LA" leaks despite being two tokens, because the tail is two characters and the
// existing gate has a three-character floor.
//
// Zero of these have reached live copy. Every capitalised word in all 24 stored openings
// traces to the prospect it belongs to, because the examples were built from those
// prospects. The hole is real, it has not fired, and it widens with volume.
//
// ─── WHY frameSkeleton IS NOT A SECOND LAYER ─────────────────────────────────
//
// Worth stating, because counting it as one is the mistake that leaves this open.
//
// frameSkeleton in sentence-frames.ts also treats index 0 specially. It is NOT a weaker
// version of this check. It is a NORMALISER for cross-variant sentence reuse, and it MASKS
// every capitalised word from index 1 onward rather than testing any of them. It never
// rejects anything, at any index. So it is not a second layer against an invented name; it
// is not a layer against invented names at all. Before this file, nothing anywhere checked
// the first word of a sentence for a proper noun.
//
// ─── HOW A NAME IS TOLD FROM AN ORDINARY WORD ────────────────────────────────
//
// Capitalisation is unavailable by definition, so three other signals are used, and a word
// is only ever rejected when it is untraceable AND looks like a name.
//
//   1. ORTHOGRAPHY. An internal capital, an all-caps run, or a digit. "HydrospherIQ",
//      "DTCC", "FinTechIQ". Measured: zero hits across all 67 sentence-initial capitalised
//      tokens in the 24 stored openings, so this signal costs nothing.
//
//   2. NOT ORDINARY ENGLISH. See ordinary-words.ts. This is the load-bearing one and it is
//      what makes the check something other than a denylist: "Taffet" is caught because it
//      is not English, and so is any company the model invents tomorrow.
//
//   3. TRACEABILITY. The same findings text untraceableClaims already uses. A genuine
//      prospect name survives because the findings are where it came from.
//
// ─── WHY NOT A LIST OF COMMON SENTENCE OPENERS ───────────────────────────────
//
// The measurement, not a preference. Across the 24 stored openings there are 67
// sentence-initial capitalised tokens, and 35 of them do not appear in their own findings.
// So untraceability ALONE would reject essentially every opening ever shipped, and whatever
// list sits beside it is not a tiebreaker, it is the entire gate.
//
// Those 35 are fifteen distinct words, and every one is ordinary English:
//
//     Between Buyers Finding Founders Most New Running Shows That Then They Those When
//     You Your
//
// Seven are open-class: Buyers, Finding, Founders, New, Most, Running, Shows. A list of
// function words misses all seven, which is six or seven of the 24 openings. At three
// writer attempts per prospect, that is roughly one extra Sonnet call each and about 2% of
// prospects dropped to the template for no reason. A false positive here has a real
// quality cost, so the discriminator has to cover open-class words, and only a vocabulary
// does that.
//
// ─── DIRECTION OF FAILURE ────────────────────────────────────────────────────
//
// AMBIGUITY RESOLVES TO ALLOW, the same rule vendor-name-gate.ts states for the same
// reason. Every uncertain case here is a missed leak, never a rejected email. That is
// deliberate: the leak has never fired in production and a wrong rejection costs a writer
// attempt every time.
//
// Deterministic (ADR-018). No model call.

import { logger } from '@/lib/logger'
import { isOrdinaryWord } from './ordinary-words'

// REPORT-ONLY FIRST, BY INSTRUCTION. Doug, 2026-08-28: "One week in report-only, logging
// what it would have rejected with the prospect, the word and the sentence. Then I flip it
// manually after reading what it caught. A gate nobody has watched fire is a gate nobody
// has tested, and this one can cost quality if it is wrong."
//
// A CONSTANT, NOT A DATE. This file does not roll over on its own. An automatic flip would
// put the gate into blocking mode without anyone having read what it caught, which is the
// only thing the observation week is for.
//
// TO FLIP: change this to 'block', and record in BACKLOG what the week's logs showed.
export type SentenceInitialGateMode = 'report' | 'block'
export const SENTENCE_INITIAL_GATE_MODE: SentenceInitialGateMode = 'report'

/** Review date, for the BACKLOG entry and for whoever finds this later. */
export const SENTENCE_INITIAL_GATE_REVIEW_AFTER = '2026-09-04'

/** Matches the existing gate's floor, so the two agree on what is too short to judge. */
const MIN_WORD_LENGTH = 3

export interface SentenceInitialNameHit {
  /** The word as written, with punctuation and possessive stripped. */
  word: string
  /** The full run when the name spans more than one token, e.g. "Sovern LA". */
  run: string
  /** Which signal marked it a name: orthography, or absence from ordinary English. */
  signal: 'orthography' | 'not-english'
  /** The sentence it opened, for the log. */
  sentence: string
}

/** An internal capital, an all-caps run, or a digit. None of these occur by convention. */
function hasNameOrthography(word: string): boolean {
  if (/\d/.test(word)) return true
  if (/^\p{Lu}{2,}$/u.test(word)) return true
  // A capital anywhere after the first letter: HydrospherIQ, FinTechIQ, LinkedIn.
  if (/^\p{Lu}.*\p{Lu}/u.test(word) && !/^\p{Lu}+$/u.test(word)) return true
  return /\p{Ll}\p{Lu}/u.test(word)
}

/** Strips surrounding punctuation and the possessive, matching the existing gate. */
function cleanToken(raw: string): string {
  return raw.replace(/[^\p{L}\p{N}'-]/gu, '').replace(/'s$/i, '')
}

/**
 * Sentence-initial capitalised words that look like names and are not in the findings.
 *
 * Pure. Does not log, does not throw. Exported for tests.
 *
 * `text` is the combined block exactly as the existing gate receives it, so the two see
 * the same tokens and the same sentence boundaries.
 */
export function findSentenceInitialNames(text: string, findingsText: string): SentenceInitialNameHit[] {
  const haystack = findingsText.toLowerCase()
  const words = text.split(/\s+/).filter(Boolean)
  const hits: SentenceInitialNameHit[] = []

  words.forEach((word, i) => {
    // The positions the existing gate exempts, and only those. Everything else is already
    // covered, and checking it twice would double-report.
    const isInitial = i === 0 || /[.!?]$/.test(words[i - 1])
    if (!isInitial) return

    const clean = cleanToken(word)
    if (clean.length < MIN_WORD_LENGTH) return
    if (!/^\p{Lu}/u.test(clean)) return

    // TRACEABILITY FIRST, and it short-circuits. A word the findings supplied is the
    // prospect's own name, company or market, and no further question is worth asking.
    // Same case-insensitive substring test the existing gate uses, so the two agree.
    if (haystack.includes(clean.toLowerCase())) return

    // A capitalised RUN is read as one name, so "Sovern LA" is judged on "Sovern" rather
    // than falling through the three-character floor on "LA". The run is for the message
    // only; the verdict is taken on the first token, which is the one nothing else checks.
    const run: string[] = [clean]
    for (let j = i + 1; j < words.length; j++) {
      const next = cleanToken(words[j])
      if (!next || !/^\p{Lu}/u.test(next)) break
      run.push(next)
      if (/[.!?]$/.test(words[j])) break
    }

    const signal: SentenceInitialNameHit['signal'] | null =
      hasNameOrthography(clean) ? 'orthography'
      : !isOrdinaryWord(clean) ? 'not-english'
      : null

    if (!signal) return

    // The sentence it opened, for a human reading the log.
    const rest: string[] = []
    for (let j = i; j < words.length; j++) {
      rest.push(words[j])
      if (/[.!?]$/.test(words[j])) break
    }

    hits.push({ word: clean, run: run.join(' '), signal, sentence: rest.join(' ') })
  })

  // One report per distinct word. A name repeated across two sentences is one problem.
  const seen = new Set<string>()
  return hits.filter(h => (seen.has(h.word) ? false : (seen.add(h.word), true)))
}

/**
 * Runs the check and logs every hit with the prospect, the word and the sentence.
 *
 * Returns the failure strings to append to the gate list, which is EMPTY in report mode.
 * That is the whole of the report-only behaviour: the hits are logged either way, and only
 * a blocking mode turns them into something the writer has to fix.
 */
export function checkSentenceInitialNames(
  text: string,
  findingsText: string,
  context: { prospectId: string },
  /**
   * Defaulted to the module constant, which is what production uses. A PARAMETER ONLY SO
   * THE BLOCKING PATH CAN BE EXECUTED BY A TEST while the constant says 'report'.
   *
   * That is the point of the observation week, taken seriously: a flip that has never been
   * run is a flip nobody has tested, and finding out it was broken at the moment of
   * flipping is the worst time to find out. Production never passes this.
   */
  mode: SentenceInitialGateMode = SENTENCE_INITIAL_GATE_MODE,
): string[] {
  const hits = findSentenceInitialNames(text, findingsText)
  if (hits.length === 0) return []

  logger.warn('sentence-initial-gate: name-shaped word opening a sentence, not in findings', {
    ...context,
    mode,
    count: hits.length,
    hits: hits.map(h => ({ word: h.word, run: h.run, signal: h.signal, sentence: h.sentence })),
  })

  if (mode !== 'block') return []

  return [
    `opens a sentence with a name nothing in the findings supplied: ` +
    hits.map(h => `"${h.run}"`).join(', ') +
    `. Every name must come from the findings. Rewrite the sentence to open with what you ` +
    `can point to, or drop the name.`,
  ]
}
