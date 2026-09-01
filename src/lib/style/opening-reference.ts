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
// STATED PLAINLY BECAUSE THE MEASUREMENT INVERTS THE OBVIOUS ASSUMPTION. The four faults a
// human read pulled out of 20 shipped openings were all the SAME shape, and findBackReferences
// catches NONE of them:
//
//   "the ones who don't know them yet"   "the ones who did not attend"
//   "the current one"                    "the next one on the calendar"
//
// Every one is "one" or "ones" standing in for a noun named in an earlier sentence. The
// demonstrative gate cannot see them: there is no demonstrative. The pronoun gate cannot see
// them: "one" and "ones" are listed in NON_NOUN_FOLLOWERS, which is correct there and makes
// them invisible here. They fall out as definite-article hits, which are report-only and fire
// on 22 of 24 openings, so they arrive buried in noise that can never be gated.
//
// MEASURED 2026-09-01 over both corpora: demonstratives flag 8 of the 20 export openings and
// pronominal-"one" flags 4 more, WITH ZERO OVERLAP. Wiring only the existing detector would
// have reported success while missing every case the read actually found. That is the shape
// CLAUDE.md calls a check that cannot see the class it was written to find, so the shape is
// detected here rather than left out and called covered.
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
// MEASURED 2026-09-01 over 44 real openings, replayed offline with zero model calls: 24
// stored in prospects.personalisation_trigger and 20 from the compare-run export. The
// numbers come from findOpeningReferences itself, not from a replay that reimplements it.
//
// TWO CORPORA WERE SMALLER THAN THEY LOOK, and saying so is the point. 36 rows carry a
// stored trigger and only 24 have a bridge paragraph; the other 12 are the older
// single-paragraph format, so there is NOTHING IN THEM TO SCAN and they are not a clean
// bill of health. The export holds 24 records and 4 have no observation or bridge at all,
// having lost the judge comparison or hit a length gate and fallen back to the template.
//
//                          stored (24)   export (20)
//   openings flagged          14            13
//   demonstrative hits        17            12
//   pronominal-one hits        4             4
//   unanchored it/they/them    0             0
//
// PRONOMINAL-"one" IS 8 FOR 8 GENUINE, and it is the shape the human read actually found.
//
// THE DEMONSTRATIVE SIGNAL IS ROUGHLY THREE QUARTERS PRECISE, read by hand over all 29:
// seven are false positives, in three distinct shapes, and all three are the ambiguity
// NON_NOUN_FOLLOWERS exists to suppress, escaping it on a word that list does not carry.
//   a degree modifier            "a firm this young"
//   a relative pronoun           "the firm that already has the answers"
//   a complementiser             "is that client development sits"
// A FOURTH SHAPE COMES FROM THE OBSERVATION PASS SPECIFICALLY: a demonstrative whose
// antecedent sits in ITS OWN SENTENCE. Three of the four observation hits are that, and
// they are correct English. The demonstrative check in back-reference.ts does not test for
// an antecedent at all, unlike the pronoun check beside it, which is why they land here.
//
// THAT WEAKNESS IS INHERITED AND DELIBERATELY NOT FIXED HERE. findBackReferences gates the
// messaging agent in BLOCK mode today. Teaching its demonstrative check to look for an
// antecedent would change what that live gate rejects, measured against a different corpus,
// in a commit about the writer. It is recorded in BACKLOG instead.
//
// SO THIS CANNOT BLOCK TODAY, and the arithmetic is the reason rather than the principle:
// gating now would reject 27 of 44 openings, seven of them wrongly. At two or three writer
// attempts per prospect a wrong rejection costs a Sonnet call and can drop the prospect to
// the approved template, which is worse copy than any of the seven sentences above. The
// prompt rule lands first. This measures whether it worked.
//
// TO FLIP: change to 'block', and only after the false-positive shapes above are excluded
// and a fresh replay measures them at zero. Record what the replay showed in BACKLOG.
export type OpeningReferenceMode = 'report' | 'block'
export const OPENING_REFERENCE_MODE: OpeningReferenceMode = 'report'

/** Review date, for the BACKLOG entry and for whoever finds this later. */
export const OPENING_REFERENCE_REVIEW_AFTER = '2026-09-15'

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
  // measured here at 41 of 44 openings, which is noise rather than signal.

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
