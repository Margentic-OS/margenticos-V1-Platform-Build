// A DATE IN COLD EMAIL IS A MONTH.
//
// The operator raised this four separate times in one blind read of twenty Email 1s, more
// often than any other single complaint in that file. Measured over 221 stored personalised
// openings: 25 named a day of the month (all 25 the fault, no false positives) and 17 named
// the current year beside a month (16 the fault).
//
// THE LAST BLOCK IN THIS FILE IS THE ONE THAT MATTERS MOST. It pins that this gate and the
// event-year gate can never demand and refuse the same year. Two rules about years whose
// remedies contradict is not a wrong answer, it is a writer with no legal move burning every
// remaining attempt, which Email 1's word floor cost seven model calls in September.

import { describe, it, expect } from 'vitest'
import { findDateGranularityFaults, dateGranularityFeedback } from '../date-granularity'
import { splitIntoSentences } from '../sentence-count'
import { missingEventYears } from '@/lib/agents/research/event-year'

const NOW = new Date('2026-09-30T00:00:00Z')
const faults = (text: string, now: Date = NOW) =>
  findDateGranularityFaults(text, now, splitIntoSentences)
const kinds = (text: string, now: Date = NOW) => faults(text, now).map(f => f.kind)

describe('a day of the month is rejected in every shape a writer produces', () => {
  // Every string here is the SHAPE of a line from the measured corpus, with the identifying
  // detail invented. Real cohort wording does not belong in a test file.
  it.each([
    ['month then day', 'You published a guide on September 13.'],
    ['month then ordinal day', 'Your programme goes live on July 21st.'],
    ['day then month', 'You reshared the listing on 9 September.'],
    ['ordinal day then month', 'You spoke on the 13th of September.'],
    ['month, day, year', 'You posted for a generalist on 23 July 2026.'],
    ['abbreviated month', 'You published it on 1 Sept.'],
    ['ISO', 'You posted it on 2026-09-13.'],
    ['slashed', 'You posted it on 13/09.'],
  ])('%s', (_label, text) => {
    expect(kinds(text)).toContain('day')
  })

  it('leaves a bare month alone, which is the legal form', () => {
    expect(faults('You published a guide in September.')).toEqual([])
    expect(faults('You ran the panel in July and promoted it yourself.')).toEqual([])
  })

  // ─── THE FALSE POSITIVES THAT SHAPED THE PATTERN ───────────────────────────
  it('does not read a month and a year as a day', () => {
    // Without the trailing digit fence the alternation matches "20" of "2026" and every
    // month-and-year phrase in the corpus becomes a day-and-month hit.
    expect(kinds('You joined the board in January 2026.')).not.toContain('day')
  })

  it('does not read a modal "may" after a number as a date', () => {
    // "12 may be enough" is ordinary English. The day-first shape cannot tell it from a date,
    // so "may" is excluded from that shape alone.
    expect(faults('Twelve of the 12 may be enough to fill the quarter.')).toEqual([])
  })

  it('still catches a real May date in the month-first shape', () => {
    // Excluding "may" from the day-first shape must not make May invisible: "May 12" has no
    // reading as a sentence, so the month-first shape keeps it.
    expect(kinds('You published it on May 12.')).toContain('day')
  })

  it('does not read a plural month word as a month', () => {
    expect(faults('The 3 marches you organised were all oversubscribed.')).toEqual([])
  })
})

describe('the current year beside a month is rejected, and nothing else is', () => {
  it('rejects the current year after a month', () => {
    expect(kinds('You joined the board in January 2026.')).toContain('year')
  })

  it('rejects the current year before a month', () => {
    expect(kinds('The 2026 February refresh went live.')).toContain('year')
  })

  // ─── THE TWO FALSE-POSITIVE FAMILIES A BARE YEAR RULE PRODUCED ─────────────
  //
  // A bare four-digit-year rule flagged 43 of 221 emails and 56% were wrong. Both families
  // are removed by requiring a month beside the year, with no extra rule.
  it('leaves a year that is part of a name alone', () => {
    expect(faults('Your Signal Trends 2026 report puts your thinking in front of buyers.')).toEqual([])
    expect(faults('You hosted a panel at Kestrel 2026 on getting unstuck.')).toEqual([])
    expect(faults('You judged the 2026 Regional Marketing Excellence Awards.')).toEqual([])
  })

  it('leaves a start date in an earlier year alone', () => {
    // event-year.ts calls this honest copy about an ongoing state, explicitly.
    expect(faults('You have run it as sole principal since September 2012.')).toEqual([])
    expect(faults('The firm has held that position since 2016 with no content behind it.')).toEqual([])
  })

  it('leaves an earlier year beside a month alone, because the other gate demands it', () => {
    expect(faults('Your role there ended in May 2025.')).toEqual([])
  })

  it('reads the year from the clock, not from when the file was written', () => {
    // A module-level constant would freeze the rejected year and the gate would silently
    // stop working on 1 January.
    const nextYear = new Date('2027-02-01T00:00:00Z')
    expect(kinds('You joined the board in January 2026.', nextYear)).not.toContain('year')
    expect(kinds('You joined the board in January 2027.', nextYear)).toContain('year')
  })
})

describe('the two year rules can never demand and refuse the same year', () => {
  // This is the property, not an example of it. For a span of years around the run date,
  // assert that no year is both owed by the event-year gate and rejected by this one.
  const CANDIDATES = [{ date: '', observation: 'You joined the Wexford advisory board.' }]

  it.each([2022, 2023, 2024, 2025, 2026, 2027])('year %i', year => {
    const candidates = [{ ...CANDIDATES[0], date: `${year}-01-15` }]
    // Copy that names the month and the year of that event, which is the only text both
    // gates can speak about at once.
    const text = `You joined the Wexford advisory board in January ${year}.`

    const owed = missingEventYears(text, candidates, NOW)
    const refused = faults(text)
      .filter(f => f.kind === 'year')
      .map(f => Number(/\d{4}/.exec(f.match)![0]))

    // The gate above is satisfied whenever the year is present, so `owed` is empty here by
    // construction; what must hold is that nothing is in BOTH lists, for every year.
    for (const y of refused) expect(owed).not.toContain(y)

    // And the stronger form: strip the year out and ask whether it becomes owed. If it does,
    // this gate must not have refused it, or there is no legal text.
    const withoutYear = text.replace(` ${year}`, '')
    const owedWhenAbsent = missingEventYears(withoutYear, candidates, NOW)
    if (owedWhenAbsent.includes(year)) {
      expect(refused).not.toContain(year)
    }
  })

  it('proves the event-year gate is live in this fixture, so the check above is not vacuous', () => {
    // A positive control. Without it every assertion above passes when missingEventYears
    // returns nothing for an unrelated reason.
    const candidates = [{ date: '2024-01-15', observation: 'You joined the Wexford advisory board.' }]
    expect(missingEventYears('You joined the Wexford advisory board in January.', candidates, NOW))
      .toEqual([2024])
  })
})

describe('the feedback names the legal form rather than the rule', () => {
  it('tells the writer to keep the month', () => {
    const day = faults('You published a guide on September 13.').find(f => f.kind === 'day')!
    expect(dateGranularityFeedback(day)).toContain('month alone')
    const year = faults('You joined the board in January 2026.').find(f => f.kind === 'year')!
    expect(dateGranularityFeedback(year)).toContain('Drop the year')
  })
})
