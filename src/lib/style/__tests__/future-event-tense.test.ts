// AN EVENT THAT HAS NOT HAPPENED YET MUST NOT BE WRITTEN IN THE PAST TENSE.
//
// The fault: a finding says someone IS LEADING a session next month, the copy says "You led".
// To the reader that is not a tense slip, it is a claim that something already happened
// which has not.
//
// THE PAST TENSE IS DETECTED BY SUBJECT PLUS VERB, never by a bare "ed" ending. This project
// has already paid for that: a FACT_MARKER built on \w+ed read "focused" as a past-tense
// fact. An adjective does not follow "you" in that position.
//
// RULE ZERO. Every fixture is invented.

import { describe, it, expect } from 'vitest'
import { findFutureEventTenseFaults, futureEventTenseFeedback } from '../future-event-tense'
import { splitIntoSentences } from '../sentence-count'

const NOW = new Date('2026-09-30T09:00:00Z')
const FUTURE = [{ date: '2026-11-12', observation: 'You are leading a session on scheduling at the regional summit.' }]
const PAST = [{ date: '2026-08-12', observation: 'You led a session on scheduling at the regional summit.' }]
type Cand = ReadonlyArray<{ date?: string | null; observation?: string | null }>
const find = (t: string, c: Cand = FUTURE) => findFutureEventTenseFaults(t, c, NOW, splitIntoSentences)

describe('an event still ahead, written as done', () => {
  it('flags "You led" about a session dated next month', () => {
    const faults = find('You led a session on scheduling at the regional summit.')
    expect(faults).toHaveLength(1)
    expect(faults[0].matched.toLowerCase()).toContain('you led')
    expect(faults[0].eventDate).toBe('2026-11-12')
  })

  it('flags the other shapes of the same fault', () => {
    expect(find('You spoke on scheduling at the regional summit.')).toHaveLength(1)
    expect(find('Your team ran the scheduling session at the regional summit.')).toHaveLength(1)
  })

  it('names the date and the phrase in the rewrite instruction', () => {
    const [f] = find('You led a session on scheduling at the regional summit.')
    const msg = futureEventTenseFeedback(f)
    expect(msg).toContain('2026-11-12')
    expect(msg).toContain('has not happened yet')
    expect(msg).toContain('still to come')
  })
})

describe('what it must not touch', () => {
  it('says nothing when the event has already happened', () => {
    expect(find('You led a session on scheduling at the regional summit.', PAST)).toEqual([])
  })

  it('says nothing about a future event written as future', () => {
    expect(find('You are leading a session on scheduling at the regional summit.')).toEqual([])
    expect(find('You will lead a session on scheduling at the regional summit.')).toEqual([])
  })

  it('does NOT fire on a word merely ending in "ed"', () => {
    // The lesson a previous check learned the expensive way: "focused" is not a past-tense
    // verb here, and neither is an adjective in that position.
    expect(find('You are focused on scheduling at the regional summit.')).toEqual([])
    expect(find('Your detailed scheduling work at the regional summit is ongoing.')).toEqual([])
  })

  it('fails OPEN when no finding resembles the sentence', () => {
    // A past-tense sentence about something outside the findings is the traceability check's
    // problem. Demanding a tense change from an unrelated row produces a rewrite nobody can
    // make, which is how the event-year gate once produced impossible demands.
    expect(find('You opened a second workshop in March.')).toEqual([])
  })

  it('says nothing when the finding carries no date', () => {
    expect(find('You led a session on scheduling at the regional summit.',
      [{ date: null, observation: 'You are leading a session on scheduling at the regional summit.' }])).toEqual([])
  })

  it('says nothing about empty input', () => {
    expect(find('')).toEqual([])
  })
})
