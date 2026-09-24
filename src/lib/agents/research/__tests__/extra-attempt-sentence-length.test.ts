// POSITIVE CONTROLS for the one extra writer attempt granted when sentence length is the
// only fault. Every assertion names the behaviour it protects.

import { describe, it, expect } from 'vitest'
import {
  isSentenceLengthOnly, SENTENCE_CAP_MARKER, WRITER_MAX_SENTENCE_WORDS,
  OBSERVATION_CAP_MARKER, OBSERVATION_MAX_WORDS,
} from '../write-opening'

// The gate builds its string from SENTENCE_CAP_MARKER, so this is the real shape.
const lengthFault = (n: number, part = 'observation') =>
  `the ${part} has a sentence of ${n} words, ${SENTENCE_CAP_MARKER} ` +
  `${WRITER_MAX_SENTENCE_WORDS}: split it into two shorter sentences rather than cutting the fact out`

describe('the extra attempt is granted only for sentence length', () => {
  it('grants on one long sentence', () => {
    expect(isSentenceLengthOnly([lengthFault(22)])).toBe(true)
  })

  it('grants when BOTH parts ran long, since both are the same fault', () => {
    expect(isSentenceLengthOnly([lengthFault(22, 'observation'), lengthFault(19, 'bridge')])).toBe(true)
  })

  it('DOES NOT grant when a content fault rides along with a length fault', () => {
    // "ONLY" is the load-bearing word. An attempt that ran long AND used a banned figure
    // is not a shape problem wearing a length label, and must not buy a retry on the
    // strength of the half that is cheap to fix.
    expect(isSentenceLengthOnly([
      lengthFault(22),
      'the observation names a headcount, which is a firmographic and is banned',
    ])).toBe(false)
  })

  it.each([
    'the observation names a headcount, which is a firmographic and is banned',
    'the bridge opens with We',
    'the observation contains an em dash',
    'the bridge makes a claim the evidence does not carry',
  ])('DOES NOT grant for a content fault alone: %s', fault => {
    expect(isSentenceLengthOnly([fault])).toBe(false)
  })

  it('DOES NOT grant on an empty gate list', () => {
    // An attempt that failed for a non-gate reason (floored, collided, judge held) has no
    // gates at all. Vacuous truth would hand a free retry to every one of them, which is
    // the every()-over-an-empty-array trap.
    expect(isSentenceLengthOnly([])).toBe(false)
  })

  // ADDED 2026-09-24, with the marker set. The observation word cap replaced the
  // one-sentence observation gate, and the marker set had to move with it: a set naming a
  // gate nothing emits is a rule that can never fire, and nothing would say so.
  const observationCapFault = (n: number) =>
    `the observation is ${n} words, ${OBSERVATION_CAP_MARKER} ${OBSERVATION_MAX_WORDS}: ` +
    `cut a fact rather than compressing the sentence, and let the bridge carry the reason`

  it('grants on the observation word cap, which is the same right-fact-wrong-shape family', () => {
    expect(isSentenceLengthOnly([observationCapFault(OBSERVATION_MAX_WORDS + 2)])).toBe(true)
  })

  it('grants when the observation is both over its cap and over the sentence cap', () => {
    expect(isSentenceLengthOnly([observationCapFault(30), lengthFault(22)])).toBe(true)
  })

  it('DOES NOT grant when a content fault rides along with the observation word cap', () => {
    expect(isSentenceLengthOnly([
      observationCapFault(30),
      'the observation names a headcount, which is a firmographic and is banned',
    ])).toBe(false)
  })

  it('the one-sentence marker is gone, so nothing matches a gate that no longer exists', () => {
    // The gate that emitted this string was deleted. If the set still held its marker, the
    // set would be lying about which faults the writer can actually produce.
    expect(isSentenceLengthOnly([
      'the observation is 2 sentences and must be ONE sentence (a semicolon or a colon counts as a break)',
    ])).toBe(false)
  })

  it('the marker really is in the gate the writer emits, not just in this test', () => {
    // A control on the control. If the gate were reworded without updating the constant,
    // the predicate would quietly stop matching and nothing else would fail.
    expect(lengthFault(22)).toContain(SENTENCE_CAP_MARKER)
    expect(lengthFault(22)).toContain(String(WRITER_MAX_SENTENCE_WORDS))
  })
})

describe('the attempt budget arithmetic', () => {
  // The loop is `i < baseAttempts + (extraGranted ? 1 : 0)`, and the extra is granted at
  // most once, on the final base iteration, only when that attempt was `gated` and
  // sentence-length-only. These pin the resulting budget.
  const budget = (strongMaterial: boolean, extra: boolean) =>
    (strongMaterial ? 3 : 2) + (extra ? 1 : 0)

  it('leaves the normal budget untouched when nothing is granted', () => {
    expect(budget(false, false)).toBe(2)
    expect(budget(true, false)).toBe(3)
  })

  it('adds exactly one, never two', () => {
    expect(budget(false, true)).toBe(3)
    expect(budget(true, true)).toBe(4)
  })

  it('the worst case is 4 writer attempts for one prospect', () => {
    // This is the number the time budget has to absorb. Named here so a future change to
    // either constant shows up as a failing assertion rather than as a slower run.
    expect(Math.max(budget(true, true), budget(false, true))).toBe(4)
  })
})
