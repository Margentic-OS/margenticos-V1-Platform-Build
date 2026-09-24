// THE YEAR RULE. An event from another year must say which year.
//
// POSITIVE CONTROLS BOTH WAYS throughout: every case that must fail is paired with the
// nearest case that must pass. A gate tested only on what it rejects is indistinguishable
// from a gate that rejects everything, which is an outage rather than a control.

import { describe, it, expect } from 'vitest'
import { eventYear, missingEventYear, missingEventYears, eventYearGateMessage } from '../event-year'
import { contentOverlap } from '../synthesize'

const NOW = new Date('2026-09-23T12:00:00Z')

describe('eventYear reads the year out of a date string', () => {
  it.each([
    ['2025-07-24', 2025],
    ['2025-07', 2025],
    ['2025', 2025],
    ['July 24, 2025', 2025],
    ['1998-10-01', 1998],
    // A RANGE TAKES ITS START, the year furthest from now, which is the stronger
    // requirement to name.
    ['2021-01-01 to 2023-01-01', 2021],
  ])('%s -> %s', (given, expected) => {
    expect(eventYear(given)).toBe(expected)
  })

  it.each([[null], [undefined], [''], ['approximate: last spring'], ['undated']])(
    '%s has no year', given => {
      expect(eventYear(given as string | null)).toBeNull()
    })
})

describe('the rule fires on a prior-year event that hides its year', () => {
  it('THE CASE THAT MOTIVATED IT: a July 2025 webinar written as "in July"', () => {
    const observation = 'You co-hosted a webinar in July on the One Big Beautiful Bill.'
    expect(missingEventYear(observation, '2025-07-24', NOW)).toBe(2025)
  })

  it('and passes the moment the same sentence names the year', () => {
    const observation = 'You co-hosted a webinar in July 2025 on the One Big Beautiful Bill.'
    expect(missingEventYear(observation, '2025-07-24', NOW)).toBeNull()
  })

  it('fires however old the event is', () => {
    expect(missingEventYear('You have run 9 Consulting as its sole principal.', '2012-09-01', NOW)).toBe(2012)
  })

  it('and a long-tenure observation that names its year passes, so the rule is not a recency floor', () => {
    const observation = 'You have run 9 Consulting as its sole principal since September 2012.'
    expect(missingEventYear(observation, '2012-09-01', NOW)).toBeNull()
  })
})

describe('the rule stays silent where it should', () => {
  it('a CURRENT-year event needs no year, which is most of the corpus', () => {
    expect(missingEventYear('You posted the HR Generalist search in July.', '2026-07-23', NOW)).toBeNull()
  })

  it('even a current-year event at the very start of the year', () => {
    expect(missingEventYear('You spoke in January.', '2026-01-02', NOW)).toBeNull()
  })

  it('an UNDATED candidate is out of scope: inventing a year would be worse than silence', () => {
    expect(missingEventYear('You appeared on episode 105.', null, NOW)).toBeNull()
    expect(missingEventYear('You appeared on episode 105.', 'undated', NOW)).toBeNull()
  })

  it('the year may appear anywhere in the observation, not only beside the month', () => {
    expect(missingEventYear('In 2025 you co-hosted a webinar on federal contracting.', '2025-07-24', NOW)).toBeNull()
  })

  it('a two-digit year does NOT satisfy it, and that is deliberate', () => {
    // "'25" is ambiguous in an email that may also carry other numbers, and the gate is
    // here precisely because an unclear date reads as a recent one.
    expect(missingEventYear("You co-hosted a webinar in July '25.", '2025-07-24', NOW)).toBe(2025)
  })

  it('the rule moves with the clock rather than pinning a year in code', () => {
    const obs = 'You co-hosted a webinar in July.'
    expect(missingEventYear(obs, '2025-07-24', new Date('2025-11-01T00:00:00Z'))).toBeNull()
    expect(missingEventYear(obs, '2025-07-24', new Date('2026-01-01T00:00:00Z'))).toBe(2025)
  })
})

describe('the gate message is also the retry instruction', () => {
  it('names the year twice: what is missing and what to add', () => {
    const m = eventYearGateMessage(2025)
    expect(m).toContain('2025')
    expect(m).toMatch(/name the year in the observation/)
    // It must say what to do, not only what is wrong. A gate that reports a failure and
    // leaves the writer to guess burns attempts, which is how Kit lost three of them.
    expect(m).toMatch(/cutting something else/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// THE GATE READS THE EVENT THE OBSERVATION NAMES, NOT THE ONE SYNTHESIS SELECTED.
//
// Measured 2026-09-24. The gate read the SELECTED candidate's date. The writer sees every
// candidate and routinely describes a different one, so the gate compared a 2025 date from
// an event the writer never mentioned against text about a 2026 event and demanded "2025".
// There was no legal move: naming 2025 would have been false. Two prospects, six attempts,
// both emails lost.
//
// Fixtures are industry-neutral. The real observations carry prospect and company names and
// are not reproduced here; what transfers is the SHAPE, which is a candidate list holding a
// current-year event the writer described and a previous-year event it did not.
describe('missingEventYears reads the event the observation actually names', () => {
  const NOW = new Date('2026-09-24T00:00:00Z')

  // The shape that lost two prospects: a dated current-year event the observation describes,
  // and a previous-year standing-arrangement candidate it does not mention.
  const CANDIDATES = [
    { date: '2026-08-25', observation: 'On 25 August 2026 the founder published a blog post about the sales bottleneck that stops a business scaling.' },
    { date: '2025-01-01', observation: 'The founder has been running the advisory alongside a concurrent finance role at another company since January 2025.' },
  ]

  it('owes nothing when the observation describes the CURRENT-year event', () => {
    // THE BUG, AS A TEST. The old gate read the second candidate and demanded 2025 here.
    const observation = 'You published a piece in August 2026 naming the sales bottleneck as the day a business stops scaling.'
    expect(missingEventYears(observation, CANDIDATES, NOW)).toEqual([])
  })

  it('owes nothing even when the current-year event is named without its year', () => {
    // A current-year event needs no year at all, which is the whole point of rule 2.
    const observation = 'You published a piece in August naming the sales bottleneck as the day a business stops scaling.'
    expect(missingEventYears(observation, CANDIDATES, NOW)).toEqual([])
  })

  it('STILL owes the year when the observation describes the PREVIOUS-year event', () => {
    // POSITIVE CONTROL THE OTHER WAY. Without this the fix would be indistinguishable from
    // deleting the gate, and the original incident it was built for would come back.
    const observation = 'You have been running the advisory alongside a concurrent finance role at another company.'
    expect(missingEventYears(observation, CANDIDATES, NOW)).toEqual([2025])
  })

  it('is satisfied once that year is named', () => {
    const observation = 'Since January 2025 you have been running the advisory alongside a concurrent finance role at another company.'
    expect(missingEventYears(observation, CANDIDATES, NOW)).toEqual([])
  })

  it('owes BOTH years when the observation names two previous-year events', () => {
    const twoOld = [
      { date: '2024-03-01', observation: 'The firm opened a second workshop in March 2024 on the north side of the city.' },
      { date: '2023-06-01', observation: 'The firm took on its first apprentice intake in June 2023 across two trades.' },
    ]
    const observation = 'You opened a second workshop in March on the north side, and took on your first apprentice intake in June across two trades.'
    expect(missingEventYears(observation, twoOld, NOW)).toEqual([2023, 2024])
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // THE DISCRIMINATION THE FIX IS ACTUALLY FOR, and this test exists because its
  // absence was caught by mutation rather than by reading.
  //
  // Removing the relative threshold, so that EVERY candidate above the floor counted as
  // described, broke nothing in the first version of this file: the previous-year candidate
  // in those fixtures scored 0.00, below the floor, so the relative rule never decided
  // anything. The test passed in both worlds, which is the shape this project calls a
  // guard that is never reached.
  //
  // The fixture below reproduces the REAL shape instead: a previous-year candidate that
  // shares enough vocabulary to clear the floor and is still plainly a different event.
  // Measured 0.250 against a best of 1.000; the live failure was 0.29 against 1.00.
  describe('a previous-year candidate that clears the floor but is not what was written', () => {
    const OBSERVATION = 'In July 2026 the firm posted that it is interviewing for a consultant to work with its clients.'
    const DESCRIBED = { date: '2026-07-23', observation: 'On 23 July 2026 the founder posted that the firm is actively interviewing for a consultant with five to seven years of experience to work with its clients.' }
    const NOT_DESCRIBED = { date: '2025-11-01', observation: 'Since November 2025 the founder has been running the firm alongside a second venture serving its own clients.' }

    it('the fixture really is in the band this rule decides', () => {
      // THE PREMISE, ASSERTED. Without this the test below could pass because the second
      // candidate fell under the floor, which is the way the first version of this file was
      // vacuous. If contentOverlap changes, this fails first and says so.
      const best = contentOverlap(OBSERVATION, DESCRIBED.observation)
      const other = contentOverlap(OBSERVATION, NOT_DESCRIBED.observation)
      expect(other).toBeGreaterThan(0.2)        // clears the absolute floor
      expect(other).toBeLessThan(best * 0.5)    // and is excluded only by the relative rule
    })

    it('owes nothing, because the event written about is from the current year', () => {
      expect(missingEventYears(OBSERVATION, [DESCRIBED, NOT_DESCRIBED], NOW)).toEqual([])
    })

    it('and still owes 2025 when the observation describes THAT candidate instead', () => {
      const other = 'You have been running the firm alongside a second venture serving its own clients.'
      expect(missingEventYears(other, [DESCRIBED, NOT_DESCRIBED], NOW)).toEqual([2025])
    })
  })

  it('owes nothing when no candidate resembles the observation', () => {
    // FAILS OPEN, deliberately. An observation about something outside the candidate list is
    // the traceability gates' problem; demanding a year off an unrelated row is what produced
    // the incident, because no rewrite can satisfy it.
    const observation = 'You sponsored a youth football team for the third season running.'
    expect(missingEventYears(observation, CANDIDATES, NOW)).toEqual([])
  })

  it('owes nothing for an undated candidate, however well it matches', () => {
    const undated = [{ date: null, observation: 'The website lists a named senior client-facing role on the team page.' }]
    const observation = 'Your website lists a named senior client-facing role on the team page.'
    expect(missingEventYears(observation, undated, NOW)).toEqual([])
  })

  it('owes nothing for an empty observation, and does not throw on an empty list', () => {
    expect(missingEventYears('', CANDIDATES, NOW)).toEqual([])
    expect(missingEventYears('You published a piece in August.', [], NOW)).toEqual([])
  })

  it('the single-event helper still behaves, since the new one is built on it', () => {
    expect(missingEventYear('You published a piece in August.', '2025-08-25', NOW)).toBe(2025)
  })
})
