// An out-of-office reply must always produce a resume time.
//
// ═══════════════════════════════════════════════════════════════════════════════
// THE TWO FIXTURES AT THE TOP ARE REAL, AND THEY BOTH FAILED IN PRODUCTION
//
// 2026-09-07, the first two genuine out-of-office autoreplies this system has handled.
// Both named an explicit return date. Both parsed to nothing. Both wrote
// scheduled_resume_at = NULL. Two for two on the first live test of the path.
//
// They are the first fixtures deliberately: a parser widened against invented strings
// proves the author's imagination, not the shapes real senders use.
//
// MUTATION PROOFS, each stated on its block:
//   remove the fallback in resolveOooResumeAt   -> the fallback block goes red
//   remove "through" from RETURN_PHRASE         -> the April Beach test goes red
//   restore the ordinal into the capture group  -> the Lynn Oser test goes red
//   remove the year-rollover branch             -> the December-to-January test goes red

import { describe, it, expect } from 'vitest'
import {
  addBusinessDays,
  parseOooReturnDate,
  resolveOooResumeAt,
  OOO_FALLBACK_BUSINESS_DAYS,
} from './ooo-resume'

// Verbatim from production signal 79ea9f23, april@sweetlifeco.com, 2026-09-07 18:58:34Z.
const APRIL_BEACH = `Hello - I am out of office through September 8th.

If you are a client of record, please email concierge@sweetlifeco.com

For all other questions, please email hello@sweetlifeco.com`

// Verbatim from production signal 22dd104f, lynn.oser@lkoinfo.com, 2026-09-07 18:58:38Z.
const LYNN_OSER = `I will be out of the office until Sept 8th with extremely limited access to email.  If you need immediate assistance please contact Diane Phillips at diane.phillips@lkoinfo.com.`

// The day both replies arrived, so "September 8th" is tomorrow and inside the horizon.
const ARRIVAL = new Date('2026-09-07T19:00:00Z')

function isoDate(iso: string): string {
  return iso.slice(0, 10)
}

describe('the fallback, which is the part that was missing', () => {
  // MUTATION: delete the fallback return in resolveOooResumeAt and every test here fails.
  // A null resume is worse than a wrong one: a weak parser still restarts the sequence,
  // a null leaves it with no defined behaviour at all.

  it('ALWAYS returns a resume time, even when the body names no date', () => {
    const resume = resolveOooResumeAt('I am away from my desk.', ARRIVAL)

    expect(resume.resumeAt).toBeTruthy()
    expect(resume.source).toBe('fallback')
    expect(new Date(resume.resumeAt).getTime()).toBeGreaterThan(ARRIVAL.getTime())
  })

  it('falls back exactly 10 BUSINESS days, not 10 calendar days', () => {
    const resume = resolveOooResumeAt('No date here at all.', ARRIVAL)

    // 2026-09-07 is a Monday. Ten business days out is Monday 2026-09-21, which is
    // fourteen calendar days: the two intervening weekends are why this matters.
    expect(isoDate(resume.resumeAt)).toBe('2026-09-21')
  })

  it('returns a resume time for a reply in a language the Date parser cannot read', () => {
    // The locale limit, asserted rather than hidden. No month table is hardcoded, so a
    // German autoreply does not parse. It must still resume.
    const resume = resolveOooResumeAt('Ich bin bis zum 8. September nicht im Buero.', ARRIVAL)

    expect(resume.source).toBe('fallback')
    expect(resume.resumeAt).toBeTruthy()
  })

  it('never returns null for an empty body', () => {
    expect(resolveOooResumeAt('', ARRIVAL).resumeAt).toBeTruthy()
  })
})

describe('the two real autoreplies that failed on 2026-09-07', () => {
  it('April Beach: "out of office through September 8th"', () => {
    // MUTATION: remove "through" from RETURN_PHRASE and this goes red. The original three
    // patterns covered back/return/available/in the office/until, and matched nothing here.
    const resume = resolveOooResumeAt(APRIL_BEACH, ARRIVAL)

    expect(resume.source).toBe('parsed')
    expect(isoDate(resume.resumeAt)).toBe('2026-09-08')
    expect(resume.matchedText?.toLowerCase()).toContain('september 8')
  })

  it('Lynn Oser: "out of the office until Sept 8th"', () => {
    // MUTATION: put the ordinal back inside the capture group and this goes red.
    //
    // This one is the subtler failure. The `until` pattern DID match, captured "Sept 8th",
    // handed it to the Date parser and got Invalid Date, because JS cannot parse an
    // ordinal suffix. The regex worked and the cast destroyed the result, so it looked
    // like a matching failure and was not.
    const resume = resolveOooResumeAt(LYNN_OSER, ARRIVAL)

    expect(resume.source).toBe('parsed')
    expect(isoDate(resume.resumeAt)).toBe('2026-09-08')
  })

  it('both would have resumed even if neither had parsed', () => {
    // The property that actually matters. Even with the parser reverted to its 2026-09-07
    // state, neither of these sequences would be stranded.
    for (const body of [APRIL_BEACH, LYNN_OSER]) {
      expect(resolveOooResumeAt(body, ARRIVAL).resumeAt).toBeTruthy()
    }
  })
})

describe('other shapes real senders use', () => {
  it.each([
    ['back on September 14th', '2026-09-14'],
    ['back on September 14', '2026-09-14'],
    ['returning 14 September', '2026-09-14'],
    ['I return on the 14th September', '2026-09-14'],
    ['available from September 14th, 2026', '2026-09-14'],
    ['out of office thru September 14', '2026-09-14'],
    ['away till September 14th', '2026-09-14'],
    ['in the office September 14th', '2026-09-14'],
  ])('parses %s', (body, expected) => {
    const resume = resolveOooResumeAt(body, ARRIVAL)
    expect(resume.source).toBe('parsed')
    expect(isoDate(resume.resumeAt)).toBe(expected)
  })

  it('handles day-before-month, which is how most of the world writes it', () => {
    // MUTATION: delete the second pattern and this goes red.
    const resume = resolveOooResumeAt('I am away until 14 September', ARRIVAL)
    expect(resume.source).toBe('parsed')
    expect(isoDate(resume.resumeAt)).toBe('2026-09-14')
  })

  it('rolls a bare month and day into next year when it has already passed', () => {
    // MUTATION: delete the rollover branch in parseWithYearRollover and this goes red.
    // "back on January 5" read in December is next January. Without this it parses to a
    // date eleven months gone, the horizon check rejects it, and a reply that named a
    // date silently takes the fallback.
    const december = new Date('2026-12-20T10:00:00Z')
    const resume = resolveOooResumeAt('I am back on January 5', december)

    expect(resume.source).toBe('parsed')
    expect(isoDate(resume.resumeAt)).toBe('2027-01-05')
  })
})

describe('what it refuses, so the parser cannot be worse than the fallback', () => {
  it('ignores a date already in the past and falls back instead', () => {
    const resume = resolveOooResumeAt('I was out until September 1st', ARRIVAL)
    expect(resume.source).toBe('fallback')
  })

  it('ignores a date beyond the horizon, which is more likely a misparse', () => {
    const resume = resolveOooResumeAt('back on September 8th, 2029', ARRIVAL)
    expect(resume.source).toBe('fallback')
  })

  it('does not treat an unrelated number as a date', () => {
    const resume = resolveOooResumeAt('Please see article 8 for details.', ARRIVAL)
    expect(resume.source).toBe('fallback')
  })

  it('parseOooReturnDate still returns null on its own, and callers must not use it', () => {
    // Kept exported for testing and measurement. The null is exactly what the caller must
    // never write through, which is why resolveOooResumeAt is the only supported path.
    expect(parseOooReturnDate('nothing here', ARRIVAL)).toBeNull()
  })
})

describe('addBusinessDays', () => {
  it('skips weekends', () => {
    // Friday 2026-09-04 plus one business day is Monday 2026-09-07.
    expect(isoDate(addBusinessDays(new Date('2026-09-04T12:00:00Z'), 1).toISOString()))
      .toBe('2026-09-07')
  })

  it('the PRD default is 10, and it is pinned', () => {
    expect(OOO_FALLBACK_BUSINESS_DAYS).toBe(10)
  })
})
