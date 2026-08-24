// Tests for the sample gate.
//
// The number this exists to stop showing: 1 reply from 26 emails renders as 3.8%, which
// lands neatly inside the published industry range and looks exactly like a measurement.
// The next reply takes it to 7.7%. A single email moves it four points.

import { describe, it, expect } from 'vitest'
import {
  readRate,
  positionInRange,
  MIN_SENDS_FOR_RATE,
  MIN_REPLIES_FOR_POSITIVE_RATE,
} from './sample-gate'

describe('readRate — when a rate may be printed', () => {
  it('refuses to report the live case: 1 reply from 26 emails', () => {
    const r = readRate(1, 26, MIN_SENDS_FOR_RATE)

    expect(r.reportable).toBe(false)
    // Null, not 3.8. A caller cannot print what it does not receive.
    expect(r.value).toBeNull()
    expect(r.shortfall).toBe(374)
  })

  it('reports once the denominator clears the minimum', () => {
    const r = readRate(16, 400, MIN_SENDS_FOR_RATE)

    expect(r.reportable).toBe(true)
    expect(r.value).toBe(4)
    expect(r.shortfall).toBe(0)
  })

  it('treats the minimum itself as enough', () => {
    expect(readRate(1, MIN_SENDS_FOR_RATE, MIN_SENDS_FOR_RATE).reportable).toBe(true)
    expect(readRate(1, MIN_SENDS_FOR_RATE - 1, MIN_SENDS_FOR_RATE).reportable).toBe(false)
  })

  it('does not report a zero rate either', () => {
    // Zero replies from 26 emails is 0%, which is just as much noise as 3.8% and reads as
    // a far more alarming claim.
    const r = readRate(0, 26, MIN_SENDS_FOR_RATE)
    expect(r.reportable).toBe(false)
    expect(r.value).toBeNull()
  })

  it('reports a genuine zero once the sample is large enough', () => {
    const r = readRate(0, 500, MIN_SENDS_FOR_RATE)
    expect(r.reportable).toBe(true)
    expect(r.value).toBe(0)
  })

  it('never divides by zero', () => {
    const r = readRate(0, 0, MIN_SENDS_FOR_RATE)
    expect(r.reportable).toBe(false)
    expect(r.value).toBeNull()
    expect(r.shortfall).toBe(MIN_SENDS_FOR_RATE)
  })

  it('carries the counts through even when the rate is withheld', () => {
    // The counts are true from the first email. Only the rate has to wait.
    const r = readRate(1, 26, MIN_SENDS_FOR_RATE)
    expect(r.numerator).toBe(1)
    expect(r.denominator).toBe(26)
    expect(r.minimum).toBe(MIN_SENDS_FOR_RATE)
  })

  it('uses a much smaller minimum for a share of replies', () => {
    // Different denominator: replies, not emails, and a proportion near half.
    expect(MIN_REPLIES_FOR_POSITIVE_RATE).toBeLessThan(MIN_SENDS_FOR_RATE)
    expect(readRate(12, 24, MIN_REPLIES_FOR_POSITIVE_RATE).reportable).toBe(false)
    expect(readRate(12, 25, MIN_REPLIES_FOR_POSITIVE_RATE).reportable).toBe(true)
  })
})

describe('positionInRange — where a number sits, not whether it is good', () => {
  it.each([
    [2, 'below'],
    [3, 'within'],
    [4.5, 'within'],
    [6, 'within'],
    [7, 'above'],
  ])('places %s as %s in a 3 to 6 range', (value, expected) => {
    expect(positionInRange(value as number, { min: 3, max: 6 })).toBe(expected)
  })

  it('treats both bounds as inside the range', () => {
    expect(positionInRange(3, { min: 3, max: 6 })).toBe('within')
    expect(positionInRange(6, { min: 3, max: 6 })).toBe('within')
  })

  it('is direction-agnostic, because good depends on the metric', () => {
    // 0.5% is 'below' for both a reply rate and a bounce rate. It is terrible for one and
    // excellent for the other, and this function deliberately does not decide which.
    expect(positionInRange(0.5, { min: 3, max: 6 })).toBe('below')
    expect(positionInRange(0.5, { min: 0, max: 2 })).toBe('within')
  })
})
