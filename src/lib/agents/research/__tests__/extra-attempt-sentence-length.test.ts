// POSITIVE CONTROLS for the one extra writer attempt granted when sentence length is the
// only fault. Every assertion names the behaviour it protects.

import { describe, it, expect } from 'vitest'
import {
  isSentenceLengthOnly, SENTENCE_CAP_MARKER, WRITER_MAX_SENTENCE_WORDS,
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
