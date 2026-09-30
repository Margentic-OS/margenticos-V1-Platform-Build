// A DATE IS ISO OR IT IS NULL. There is no third answer, because the third answer was a guess.
//
// Handing a free-text date to new Date() does not fail loudly, it guesses, and the guess can
// be years out. This file's first test proves the old behaviour was wrong before anything
// here claims the new one is right.
//
// RULE ZERO. No fixture names a client, market or buyer.

import { describe, it, expect } from 'vitest'
import { parseFindingDate, isMachineReadableDate } from '../finding-date'

describe('the forms we write are read', () => {
  it('accepts YYYY-MM-DD, YYYY-MM, YYYY and a timestamp', () => {
    expect(parseFindingDate('2026-09-12')?.toISOString().slice(0, 10)).toBe('2026-09-12')
    expect(parseFindingDate('2026-09')?.toISOString().slice(0, 10)).toBe('2026-09-01')
    expect(parseFindingDate('2026')?.toISOString().slice(0, 10)).toBe('2026-01-01')
    expect(parseFindingDate('2026-09-12T10:30:00Z')?.toISOString().slice(0, 10)).toBe('2026-09-12')
  })
})

describe('everything else is refused rather than guessed at', () => {
  it('PROVES the old behaviour was wrong, then refuses it', () => {
    // new Date() reads the "-17" as the year and discards the 2026.
    expect(new Date('September 12-17, 2026').getUTCFullYear()).toBe(2017)
    expect(parseFindingDate('September 12-17, 2026')).toBeNull()
  })

  it('refuses every prose form synthesis has been observed to produce', () => {
    // All of these were read from stored findings on 2026-09-30.
    for (const raw of [
      'approximate: August-September 2026',
      'approximate: July-September 2026',
      'approximate April 2025 (Tax Day context)',
      'approximate: 2025',
      'approximate: roles ended Apr 2025 and Mar 2026',
      'ongoing since 2018-02-01',
      'approximate description: copyright 2024, no dated content found',
      'approximate description: 180-day window ending at research date',
    ]) expect(parseFindingDate(raw), raw).toBeNull()
  })

  it('refuses the shapes new Date() would happily accept', () => {
    for (const raw of ['12 September 2026', 'Sept 2026', 'Q3 2026', 'summer 2026']) {
      expect(parseFindingDate(raw), raw).toBeNull()
    }
  })

  it('refuses absent and empty input', () => {
    expect(parseFindingDate(null)).toBeNull()
    expect(parseFindingDate(undefined)).toBeNull()
    expect(parseFindingDate('')).toBeNull()
  })
})

describe('isMachineReadableDate agrees with the parser, always', () => {
  it('is exactly "parseFindingDate did not return null"', () => {
    // Two answers to one question is the drift shape. This asserts there is only one.
    for (const raw of ['2026-09-12', '2026-09', '2026', 'approximate: 2025', 'Q3 2026', '', null]) {
      expect(isMachineReadableDate(raw), String(raw)).toBe(parseFindingDate(raw) !== null)
    }
  })
})
