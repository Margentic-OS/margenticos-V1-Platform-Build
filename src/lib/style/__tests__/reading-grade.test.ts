// The four controls on the Flesch-Kincaid instrument, promoted from the read-only
// self-test in .writer-export/analysis-20260922/fk.ts so they run on every suite rather
// than when someone remembers to invoke a script.
//
// WHY AN INSTRUMENT NEEDS CONTROLS AT ALL. A reading grade is a number the eye cannot
// check. If the syllable counter drifts, every grade in the reading file moves together
// and still looks plausible, so nothing downstream can notice. These four controls are
// the only thing standing between "the templates read at grade 4" and "the counter reads
// at grade 4".
//
// Control 1 pins the one judgement call in the formula (syllables).
// Controls 2 and 3 pin the two ends of the range.
// Control 4 pins the MIDDLE, because an instrument that is monotonic but wrongly scaled
//   passes both ends and fails everywhere it is actually used.

import { describe, it, expect } from 'vitest'
import {
  fleschKincaidGrade,
  syllables,
  splitSentencesFk,
  wordsOf,
  SYLLABLE_CONTROL_WORDS,
  CONTROL_SIMPLE,
  CONTROL_SIMPLE_GRADE,
  CONTROL_COMPLEX,
  CONTROL_COMPLEX_GRADE,
  CONTROL_BENCHMARK,
  CONTROL_BENCHMARK_GRADE,
  MAX_READING_GRADE,
} from '../reading-grade'

describe('reading grade: control 1, the syllable counter', () => {
  // Table-driven so a failure names the word rather than just the count. Every word here
  // is hand-verified, and the corpus half of the list is the vocabulary the templates
  // actually use.
  it.each(SYLLABLE_CONTROL_WORDS.map(([w, n]) => ({ word: w, expected: n })))(
    'syllables("$word") is $expected',
    ({ word, expected }) => {
      expect(syllables(word)).toBe(expected)
    },
  )

  it('covers enough of the corpus vocabulary to be worth trusting', () => {
    // Guards the guard. If someone trims the control list down to a handful, the suite
    // would still be green while the counter went effectively unchecked.
    expect(SYLLABLE_CONTROL_WORDS.length).toBeGreaterThanOrEqual(50)
  })
})

describe('reading grade: controls 2 and 3, the ends of the range', () => {
  it('control 2, simple prose lands where hand arithmetic says', () => {
    const r = fleschKincaidGrade(CONTROL_SIMPLE)!
    expect(r.words).toBe(6)
    expect(r.sentences).toBe(1)
    expect(r.syllables).toBe(6)
    expect(r.grade).toBeCloseTo(CONTROL_SIMPLE_GRADE, 2)
  })

  it('control 3, complex prose lands where hand arithmetic says', () => {
    const r = fleschKincaidGrade(CONTROL_COMPLEX)!
    expect(r.words).toBe(10)
    expect(r.sentences).toBe(1)
    expect(r.syllables).toBe(40)
    expect(r.grade).toBeCloseTo(CONTROL_COMPLEX_GRADE, 2)
  })

  it('separates simple from complex by a wide margin', () => {
    // A counter that returned a constant would pass neither control above, but one that
    // was merely compressed could pass both within tolerance while flattening everything
    // in between. This asserts the instrument still has range.
    const simple = fleschKincaidGrade(CONTROL_SIMPLE)!
    const complex = fleschKincaidGrade(CONTROL_COMPLEX)!
    expect(complex.grade - simple.grade).toBeGreaterThan(25)
  })
})

describe('reading grade: control 4, the middle of the range', () => {
  it('the 7-percent-reply benchmark line lands where hand arithmetic says', () => {
    const r = fleschKincaidGrade(CONTROL_BENCHMARK)!
    expect(r.words).toBe(21)
    expect(r.sentences).toBe(2)
    expect(r.syllables).toBe(27)
    expect(r.grade).toBeCloseTo(CONTROL_BENCHMARK_GRADE, 2)
  })

  it('the benchmark passes the gate the templates are being held to', () => {
    // The target is not arbitrary: the copy we are imitating clears it. If this ever
    // fails, either the threshold moved or the instrument did, and both are worth
    // stopping for.
    const r = fleschKincaidGrade(CONTROL_BENCHMARK)!
    expect(r.grade).toBeLessThanOrEqual(MAX_READING_GRADE)
  })
})

describe('reading grade: tokenising', () => {
  it('ends a sentence on punctuation, not on a paragraph break', () => {
    // Pins the ACTUAL behaviour, which is the opposite of what a reader might assume.
    // Two unterminated paragraphs fuse into one sentence; two terminated ones do not.
    // This is safe on email bodies only because emailProse() strips the greeting and
    // sign-off first, and those are the only unterminated paragraphs in the corpus.
    expect(splitSentencesFk('One line here\n\nAnother line here').length).toBe(1)
    expect(splitSentencesFk('One line here.\n\nAnother line here.').length).toBe(2)
  })

  it('splits hyphenated compounds into their parts', () => {
    // "founder-led" is two words and three syllables. Counted as one word it would both
    // undercount words and overcount syllables per word, pushing the grade up.
    expect(wordsOf('founder-led firms')).toEqual(['founder', 'led', 'firms'])
  })

  it('reads a numeral aloud rather than skipping it', () => {
    expect(syllables('2018')).toBe(4)
    expect(syllables('35')).toBe(2)
  })

  it('refuses rather than returning a grade for empty prose', () => {
    // Null is deliberate. Zero would read as a suspiciously good grade and pass a gate.
    expect(fleschKincaidGrade('')).toBeNull()
    expect(fleschKincaidGrade('   \n\n  ')).toBeNull()
  })
})
