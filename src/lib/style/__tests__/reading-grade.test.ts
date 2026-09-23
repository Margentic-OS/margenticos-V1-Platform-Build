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
  EMAIL1_MAX_READING_GRADE,
  readingGradeCapFor,
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

  it('the benchmark passes the STRICTEST gate the templates are held to', () => {
    // The target is not arbitrary: the copy we are imitating clears it. Asserted against
    // Email 1's ceiling, which is the tighter of the two, so a loosening of the follow-up
    // ceiling can never make this pass by accident.
    const r = fleschKincaidGrade(CONTROL_BENCHMARK)!
    expect(r.grade).toBeLessThanOrEqual(EMAIL1_MAX_READING_GRADE)
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

describe('the grade ceiling is per position', () => {
  // POSITIVE CONTROL, BOTH DIRECTIONS. The DIRECTION OF THIS PAIR FLIPPED on 2026-09-23 and
  // that is the thing worth pinning. Email 1 used to be the LOOSER of the two, 6 against 5.
  // It is now the STRICTER, 6 against 8, because the two ceilings answer different questions:
  //
  //   Email 1's 6     an IDEAL. It is read cold by a stranger with no prior message.
  //   emails 2-4's 8  a MEASUREMENT. It is the worst grade in v6's approved copy, rounded
  //                   up, so approved copy passes and anything worse fails.
  //
  // A test that just asserted "they differ" would have survived the flip without noticing.
  it('Email 1 is the STRICTER of the two, not the looser', () => {
    expect(EMAIL1_MAX_READING_GRADE).toBe(6)
    expect(MAX_READING_GRADE).toBe(8)
    expect(EMAIL1_MAX_READING_GRADE).toBeLessThan(MAX_READING_GRADE)
  })

  it('readingGradeCapFor returns 6 for Email 1 and 8 for the rest', () => {
    expect(readingGradeCapFor(1)).toBe(EMAIL1_MAX_READING_GRADE)
    expect([2, 3, 4].map(readingGradeCapFor)).toEqual([8, 8, 8])
  })

  it('THE PAIR: a grade of 7.0 is illegal in Email 1 and legal in emails 2 to 4', () => {
    const grade = 7.0
    expect(grade).toBeGreaterThan(readingGradeCapFor(1))
    expect(grade).toBeLessThanOrEqual(readingGradeCapFor(2))
  })

  it('the emails 2 to 4 ceiling admits v6 approved copy, which peaked at 7.84', () => {
    // The whole point of 8 is that it was set FROM the approved document rather than chosen.
    // If it ever drops below 7.84, copy the operator already approved starts failing.
    expect(MAX_READING_GRADE).toBeGreaterThanOrEqual(7.84)
    // And it must not be so loose it admits what v6's Email 1s looked like, 8.72 to 10.44.
    expect(MAX_READING_GRADE).toBeLessThan(8.72)
  })

  it('the benchmark clears the STRICTER of the two', () => {
    // The looser follow-up ceiling must not quietly become the thing the target is judged
    // against. The 7-percent-reply line clears Email 1's 6, not merely the follow-ups' 8.
    expect(fleschKincaidGrade(CONTROL_BENCHMARK)!.grade).toBeLessThanOrEqual(EMAIL1_MAX_READING_GRADE)
  })
})
