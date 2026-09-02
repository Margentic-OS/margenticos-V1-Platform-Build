// Back-reference detection for the RESEARCH WRITER's observation and bridge.
//
// ─── WHAT THIS ADDS, AND WHAT IT REUSES ──────────────────────────────────────
//
// The detector already exists. findBackReferences in back-reference.ts has been running
// since the frame-guard work, and it runs in ONE place: the messaging agent, on Email 1,
// over an authored document. It has NEVER seen writer output. This file is the wiring, not
// a second detector: the demonstrative and pronoun logic is imported, never restated.
//
// WHY THE WRITER NEEDS IT AT ALL, given the messaging agent already has it. The two run on
// different text. The messaging agent checks the AUTHORED frame, where P2 is an empty slot.
// The writer produces the thing that FILLS that slot, plus the bridge underneath it, and
// nothing has ever checked either. A back-reference written here is invisible to the gate
// that exists, because that gate ran before this text was written.
//
// ─── THE FRAME MAPPING ───────────────────────────────────────────────────────
//
// findBackReferences numbers paragraphs against the P1..P5 email frame and EXEMPTS the
// first content paragraph, because in an email that paragraph is the replaced slot and a
// demonstrative inside it always ships with its own antecedent.
//
// The writer's two parts are passed as two paragraphs, so:
//   observation -> index 0, exempt by that rule
//   bridge      -> index 1, reported as "paragraph 3"
//
// That exemption is CORRECT for the bridge's relationship to the observation and WRONG for
// the observation's relationship to itself: the observation is the first thing the prospect
// reads, so a demonstrative in its second sentence points at nothing at all. So the
// observation is scanned in a second pass, with a placeholder paragraph in front of it to
// move it out of the exempt position. See scanPart below.
//
// ─── PRONOMINAL "one" IS DETECTED HERE AND NOT IN back-reference.ts ──────────
//
// The four faults a human read pulled out of 20 shipped openings were all the SAME shape,
// and findBackReferences catches NONE of them:
//
//   "the ones who don't know them yet"   "the ones who did not attend"
//   "the current one"                    "the next one on the calendar"
//
// Every one is "one" or "ones" standing in for a noun named in an earlier sentence. The
// demonstrative gate cannot see them: there is no demonstrative. The pronoun gate cannot see
// them: "one" and "ones" are listed in NON_NOUN_FOLLOWERS, which is correct there and makes
// them invisible here. They fall out as definite-article hits, which are report-only and fire
// on 22 of 24 corpus A openings, so they arrive buried in noise that can never be gated.
//
// THE "ZERO OVERLAP" CLAIM THAT ORIGINALLY JUSTIFIED THIS FILE DID NOT SURVIVE FRESH DATA,
// and it is corrected here rather than left standing. On corpus A the two signals hit
// disjoint openings, which read as proof that wiring only the existing detector would have
// reported success while missing every case the human read found. Re-measured on corpus B
// (both corpora defined below), the openings split:
//
//   flagged by BOTH signals            7
//   demonstratives alone              20
//   pronominal-"one" alone             3   <- of these, ONE is genuine and two are not
//   clean                             11
//
// So this shape earns its place by ONE OPENING IN 41, not by the disjoint set the first
// measurement suggested. It is kept, because one opening is still one the existing detector
// cannot reach and the signal is cheap and report-only, but the original argument for it was
// stronger than the evidence and is not repeated here.
//
// It is NOT added to findBackReferences itself, because that function gates the messaging
// agent in BLOCK mode today and this shape has never been measured against authored email
// copy. Widening a live hard gate on the strength of a different corpus is the change that
// drops a whole variant.
//
// ─── REPORT ONLY ─────────────────────────────────────────────────────────────
//
// Returns an empty array while the mode constant says 'report'. Same contract as
// sentence-initial-names.ts: the caller pushes the result into the hard-failure channel, and
// in report mode there is nothing to push. Deterministic, no model call (ADR-018).

import { logger } from '@/lib/logger'
import { findBackReferences } from './back-reference'

// REPORT-ONLY ON INTRODUCTION, and unlike the sentence-initial gate this one has NOT been
// measured at a zero false-positive rate. It cannot be flipped on the strength of the
// numbers below.
//
// TWO MEASUREMENTS ARE RECORDED, NOT ONE, because the second corrects the first and the
// DIFFERENCE between them is the thing worth carrying. Both come from findOpeningReferences
// itself, replayed offline with zero model calls, not from a replay that reimplements it.
//
// CORPUS A, measured 2026-09-01. 44 openings drawn from AT MOST 24 DISTINCT PROSPECTS: 24
// stored in prospects.personalisation_trigger, plus 20 from the compare-run export, which
// re-generated the same population. 36 rows carry a stored trigger and only 24 have a bridge
// paragraph; the other 12 are the older single-paragraph format, so THERE IS NOTHING IN THEM
// TO SCAN and their silence is not a clean bill of health. The export holds 24 records and 4
// have no observation or bridge at all, having lost the judge comparison or hit a length gate.
//
// CORPUS B, measured 2026-09-01. 41 openings from 41 DISTINCT PROSPECTS, each generated once:
// every prospect researched that day whose stored trigger carries both paragraphs.
//
//                              corpus A                corpus B
//                              44 openings             41 openings
//                              <=24 prospects          41 prospects
//   openings flagged             27 of 44                30 of 41
//   demonstrative hits           29                      30
//   demonstrative precision      ~76%  (22 of 29)        57%  (17 of 30)  <- corrected below
//   pronominal-one hits           8                      10
//   pronominal-one precision     100%  (8 of 8)          30%  (3 of 10)
//   unanchored it/they/them       0                       0
//
// WHY THE TWO DISAGREE, and this is the part to carry rather than either set of numbers.
// CORPUS A WAS 24 PROSPECTS GENERATED REPEATEDLY, so its hits are CORRELATED BY PROSPECT:
// the same sentence, regenerated, is counted again. Its effective sample was far smaller
// than its hit count made it look, and a perfect 8 for 8 spread over a handful of repeated
// sentences is not evidence that a signal is precise. Corpus B is one opening per prospect,
// so its denominators are real and independent. READ CORPUS B. Corpus A is kept only so the
// correction stays visible instead of the old number being quietly overwritten.
//
// THE FALSE-POSITIVE SHAPES, hand-read over all 40 corpus B hits. The demonstrative signal's
// misses are FOUR shapes, and all four are the ambiguity NON_NOUN_FOLLOWERS exists to
// suppress, escaping it on a word that list does not carry:
//
//   a relative pronoun                    5   "a gap that rarely opens"
//   an antecedent in the SAME sentence    4   "the hours that are left ... those hours go last"
//   a complementiser                      2   "find that new conversations wait"
//   a deictic "this"                      2   "this business", "this February"
//
// A FIFTH SHAPE WAS LISTED HERE AND WAS WRONG. It read:
//
//   a degree modifier                     1   "a reputation that strong"
//
// CORRECTED 2026-09-02, and the correction is left visible rather than the row deleted,
// because it moves this signal's precision the right way and the mistake is instructive.
// "a reputation that strong" was judged in isolation, where a degree word appears to bind
// nothing. Read with the paragraph above it, it binds outright:
//
//   observation: your firm has served 600-plus businesses over nearly 30 years, with
//                1,500 leaders reading your monthly newsletter
//   bridge:      "A local reputation that strong fills the room with people who already
//                know you."
//
// "that strong" means AS STRONG AS THOSE FIGURES. Four further instances were measured
// across the 41-prospect arm and the 103 shipped bridges: "A network that large",
// "A newsletter that size", "A room that size", "A roster that size". ALL FOUR bind a
// figure the observation states. Five of five.
//
// So corpus B's demonstrative precision is 17 of 30, not 16 of 30: 57%, not 53%. Still far
// too low to block, and the direction matters more than the point: a degree word cannot be
// judged without the paragraph above it, and the reason the shape looked innocent is that
// it was checked against a prompt specimen shown with no observation at all.
//
// THE DEICTIC "this" SHAPE IS NEW AND WAS NOT IN THE FIRST RECORD. It points at the world the
// reader is standing in, not backwards at a noun. Nothing is being referred to, so there is
// nothing that can go missing when the paragraph above is replaced at composition. It comes
// from the observation pass specifically, and it is the shape most likely to recur, because
// the observation is written about the present.
//
// ALL SEVEN pronominal-"one" misses are the same-sentence shape: an apposition, or a noun
// named in the same sentence. Every one of them is ordinary English.
//
// THAT SAME-SENTENCE WEAKNESS IS INHERITED AND DELIBERATELY NOT FIXED HERE. The demonstrative
// check in back-reference.ts does not test for an antecedent at all, unlike the pronoun check
// beside it. findBackReferences gates the messaging agent in BLOCK mode today, so teaching it
// to look for an antecedent would change what that live gate rejects, measured against a
// different corpus, inside a commit about the writer. It is recorded in BACKLOG instead.
//
// SO THIS CANNOT BLOCK, and the arithmetic is the reason rather than the principle. Gating on
// corpus B would reject 30 of 41 openings, and 21 of the 40 hits behind them are wrong. At two
// or three writer attempts per prospect a wrong rejection costs a Sonnet call and can drop the
// prospect to the approved template, which is worse copy than any sentence it would reject.
// The prompt rule lands first. This measures whether it worked.
//
// TO FLIP: NOT ON A DATE. No review date is recorded here, and the absence is deliberate.
// There is no day on which this becomes flippable; it becomes flippable on EVIDENCE, and the
// evidence is specific: a SENTENCE-SCOPED variant of this check, one that clears a pointer
// whose antecedent sits in its own sentence, measured clean on a corpus large enough that
// "clean" means something. One opening per prospect, and enough of them that the denominator
// carries weight.
//
// THREE OF THREE ON CORPUS B IS NOT THAT EVIDENCE. Sentence-scoping would remove all seven
// pronominal-"one" false positives, leaving its three genuine hits and reading 3 of 3. Three
// is a handful, and the same signal read 8 for 8 on corpus A immediately before falling to
// 3 of 10 once the denominators were independent. A perfect score on a tiny corpus is what
// this entry exists to warn about. Record what any future replay shows in BACKLOG.
export type OpeningReferenceMode = 'report' | 'block'
export const OPENING_REFERENCE_MODE: OpeningReferenceMode = 'report'

/**
 * "one" or "ones" standing in for a noun named earlier.
 *
 * Anchored on a determiner so that "one" as a NUMBER is not matched: "one client", "one of
 * the two". The determiner slot allows up to two intervening adjectives, which is what
 * catches "the current one" and "the next one" without matching across a sentence boundary.
 */
const PRONOMINAL_ONE = /\b(the|another|each|every|whichever|which)\s+(?:[a-z-]+\s+){0,2}(ones?)\b/gi

export interface OpeningReferenceHit {
  /** 'observation' or 'bridge'. The writer's parts, not email paragraph numbers. */
  part: 'observation' | 'bridge'
  /** What kind of pointer it is. */
  kind: 'demonstrative' | 'pronoun' | 'pronominal-one'
  /** The phrase as written. */
  phrase: string
  /** The sentence it sits in, for the log. */
  sentence: string
}

/** The sentence containing `needle`, for the log line. Falls back to the whole part. */
function sentenceContaining(text: string, needle: string): string {
  const sentences = text.split(/(?<=[.!?])\s+/)
  return (sentences.find(s => s.toLowerCase().includes(needle.toLowerCase())) ?? text).trim()
}

/**
 * Scans ONE part.
 *
 * `precededBy` is the text that ships above this part, or null when nothing does.
 * findBackReferences exempts its first content paragraph, so a part that must itself be
 * scanned is passed with a placeholder in front of it to move it off index 0. The
 * placeholder is a single word with no noun in it, so it can never supply an antecedent
 * and can never change a verdict.
 */
function scanPart(text: string, part: 'observation' | 'bridge'): OpeningReferenceHit[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  const hits: OpeningReferenceHit[] = []

  const report = findBackReferences(`and\n\n${trimmed}`)

  for (const d of report.demonstratives) {
    hits.push({ part, kind: 'demonstrative', phrase: d.phrase, sentence: sentenceContaining(trimmed, d.phrase) })
  }
  for (const p of report.unanchoredPronouns) {
    hits.push({ part, kind: 'pronoun', phrase: p.pronoun, sentence: p.context })
  }
  // Definite articles are deliberately NOT read: report-only in the source detector, and
  // measured at 41 of the 44 corpus A openings, which is noise rather than signal.

  for (const m of trimmed.matchAll(PRONOMINAL_ONE)) {
    hits.push({ part, kind: 'pronominal-one', phrase: m[0], sentence: sentenceContaining(trimmed, m[0]) })
  }

  return hits
}

/**
 * Every pointer in the two parts, whatever the mode.
 *
 * EXPORTED SO THE MEASUREMENT AND THE TESTS RUN THE SHIPPED CODE. The alternative is a
 * replay script that reimplements the scan, which is the fake-that-does-not-honour-the-
 * filter shape: it would agree with this file on the day it was written and drift silently
 * afterwards. checkOpeningReferences below is the only thing that knows about the mode.
 */
export function findOpeningReferences(observation: string, bridge: string): OpeningReferenceHit[] {
  return [...scanPart(observation, 'observation'), ...scanPart(bridge, 'bridge')]
}

/**
 * Checks the writer's observation and bridge for sentences that point back instead of
 * naming the thing again.
 *
 * RETURNS AN EMPTY ARRAY while OPENING_REFERENCE_MODE is 'report'. Every hit is logged with
 * the prospect, the part, the phrase and the sentence, which is what the observation period
 * is for. A non-empty return means REJECT THE ATTEMPT, so nothing is returned until the
 * false-positive shapes recorded above are measured at zero.
 */
export function checkOpeningReferences(
  observation: string,
  bridge: string,
  context: { prospectId: string },
): string[] {
  const hits = findOpeningReferences(observation, bridge)
  if (hits.length === 0) return []

  for (const h of hits) {
    logger.info('writer-back-reference: would reject', {
      prospectId: context.prospectId,
      mode: OPENING_REFERENCE_MODE,
      part: h.part,
      kind: h.kind,
      phrase: h.phrase,
      sentence: h.sentence,
    })
  }

  if (OPENING_REFERENCE_MODE !== 'block') return []

  return hits.map(
    h => `${h.part} points back instead of naming the thing again ("${h.phrase}"): name the subject again rather than pointing at it`,
  )
}
