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
//
// ─── FLIPPED TO 'block' ON 2026-08-31 ────────────────────────────────────────
//
// THE OBSERVATION WEEK DID NOT HAPPEN, AND NOTHING ABOVE THIS LINE IS WITHDRAWN. The
// reasoning for wanting one still stands; what changed is that it could not be had. The
// writer HAS NOT RUN IN PRODUCTION SINCE THIS GATE MERGED, so the log the week was meant
// to fill is empty, and waiting longer would have produced another empty log rather than
// evidence. An OFFLINE REPLAY over stored copy was substituted for it. Recorded in
// docs/BACKLOG.md as fact.
//
// THE CORPUS. 60 real openings, replayed in the PRODUCTION SHAPE, meaning the joined
// opening plus the closing question rather than the trigger alone:
//   36  every opening stored in prospects.personalisation_trigger, all organisations,
//       each judged against its own findings rebuilt with buildFindingsBlock. TWELVE of
//       these have EMPTY findings, so nothing in them is traceable and every token falls
//       through to the vocabulary. Those twelve are the harshest cases in the corpus and
//       they are where the one false positive was found. They were dropped by the first
//       version of the replay and including them is what surfaced it.
//   24  the fresh writer outputs in .writer-export, judged against the findings behind
//       their own source_result_id.
//
// THE RESULT. 142 sentence-initial tokens examined: 65 cleared by traceability, 77 cleared
// as ordinary English, ZERO HITS. The flip is on a measured zero false-positive rate, not
// on an argument. Before the two fixes below the same replay produced ONE.
//
// TWO FIXES WENT IN FIRST, BOTH FOUND BY THE REPLAY RATHER THAN BY READING:
//
//   1. THE IRREGULAR VERB GAP. "Saw your post from last week" was rejected. "see" is in
//      the vocabulary, "saw" is not, and every rule in lemmaCandidates is a SUFFIX rule,
//      which an irregular past tense escapes by changing the stem. Fixed with an
//      irregular-form map in ordinary-words.ts. That was the only false positive in the
//      whole corpus.
//
//   2. THE TRACEABILITY SUBSTRING WEAKNESS. Traceability was a bare `includes`, so a short
//      name sitting inside a longer ordinary word was cleared as though the findings had
//      supplied it. Measured over the 262 real findings blocks: "SEC" was falsely cleared
//      by 104 of them via "section"/"sector"/"second"/"securities", and "Pani" by 38 via
//      "companies". Now matched on word boundaries.
//
// THE SPLICE CONTROL, over the same 60 openings, each entity judged only against findings
// that do not already name it: 13 of 16 before, 15 of 16 after for this gate alone, and
// 16 of 16 for the production path once untraceableClaims is counted. The one this gate
// still does not catch alone is "Blue Sky", covered by untraceableClaims on the tail
// "Sky"; see the multi-token note on the run-building loop below.
export type SentenceInitialGateMode = 'report' | 'block'
export const SENTENCE_INITIAL_GATE_MODE: SentenceInitialGateMode = 'block'

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

/**
 * True when the findings contain this word AS A WORD, not merely as a run of characters.
 *
 * ─── WHY THIS IS NOT `haystack.includes(word)` ───────────────────────────────
 *
 * It was, and that is a hole. A bare substring test clears any short name that happens to
 * sit inside a longer ordinary word, and the findings block is full of ordinary words.
 *
 * MEASURED 2026-08-31, against the 262 real findings blocks stored in
 * prospect_research_results rather than against invented examples:
 *
 *   SEC   substring-cleared by 120 blocks, only 16 of which actually name it.
 *         104 FALSE CLEARS, carried by "section", "sector", "second", "securities".
 *   Pani  substring-cleared by 57 blocks, only 19 of which actually name it.
 *         38 FALSE CLEARS, carried by "companies".
 *
 * Two corrections worth keeping, because both were assumed wrong first. The Pani carrier
 * is "companies", not "company": "company" contains "pan", not "pani". And SEC, not Pani,
 * is the worst case in the set, by a factor of nearly three. Neither fact survives being
 * reasoned about; both came from running the comparison over the real corpus.
 *
 * "Sole", "Knot", "Ito" and "Cave" were checked the same way and collide with nothing, so
 * they are not listed as though they did.
 *
 * The shorter the name, the likelier the collision, and short names are exactly the ones
 * the three-character floor already leaves thinly covered.
 *
 * ─── DELIBERATELY NOT APPLIED TO untraceableClaims ───────────────────────────
 *
 * The comment this replaces said "the same case-insensitive substring test the existing
 * gate uses, so the two agree". They no longer agree, and that is a choice rather than an
 * oversight.
 *
 * untraceableClaims in write-opening.ts is ALREADY BLOCKING in production. Tightening its
 * traceability test makes it STRICTER, so it would begin rejecting openings that ship
 * today, and the cost of that lands on live copy rather than on a report-only log. This
 * gate is the one being flipped and the one that has been measured, so this is the one
 * that gets the fix. Widening it to untraceableClaims is a separate change with its own
 * measurement, and it is recorded in BACKLOG rather than smuggled in here.
 *
 * `\b` is not used: it treats a hyphen and an apostrophe as boundaries in ways that differ
 * from cleanToken, which keeps both inside a token. Letters and digits are the only
 * characters that continue a word here, which matches how the tokens were built.
 */
function isTraceable(clean: string, haystack: string): boolean {
  const escaped = clean.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u').test(haystack)
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
    if (isTraceable(clean, haystack)) return

    // A capitalised RUN is read as one name, so "Sovern LA" is judged on "Sovern" rather
    // than falling through the three-character floor on "LA". The run is for the message
    // only; the verdict is taken on the first token, which is the one nothing else checks.
    //
    // THE VERDICT IS STILL FIRST-TOKEN ONLY, DELIBERATELY, AND THIS IS THE RESIDUAL GAP.
    // "Blue Sky" leaks here because "Blue" is ordinary English, so the run is cleared on
    // its first token while "Sky" is never judged. Taking the verdict across the whole run
    // would catch it, and was NOT done, because every token after the first is not
    // sentence-initial and is therefore ALREADY CHECKED by untraceableClaims. Judging them
    // here would double-report the same word from two gates. The production path does
    // catch "Blue Sky", on the tail, which is what the paired test at the bottom of
    // sentence-initial-names.test.ts asserts.
    //
    // The true residual gap is narrower than "multi-token names": a run whose first token
    // is ordinary English AND whose every remaining token is under the three-character
    // floor, e.g. "Blue Ox". Closing that means changing how the two gates divide the
    // work, not editing this loop, so it is in BACKLOG rather than done here.
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
