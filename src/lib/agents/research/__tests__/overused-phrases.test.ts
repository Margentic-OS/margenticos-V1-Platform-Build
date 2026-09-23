// THE PER-BATCH REPETITION TALLY, which replaces the block.
//
// The threshold has to be tested from both sides. A tally that flags everything is as
// useless as one that flags nothing, and the whole reason the gate was removed is that it
// fired on ordinary convergence.

import { describe, it, expect } from 'vitest'
import { overusedPhrases, OVERUSE_FRACTION } from '../batch-uniqueness'

/** Distinct enough that frameShingles will not collide them by accident. */
function shipped(n: number, bridge: (i: number) => string, question: (i: number) => string) {
  return Array.from({ length: n }, (_, i) => ({
    prospect_id: `p${i}`, bridge: bridge(i), question: question(i),
  }))
}

const SHARED = 'The weeks you spend delivering are weeks nobody is filling the diary.'
/**
 * DISTINCT QUESTIONS, not "Question 1?", "Question 2?". sentenceKey normalises numbers and
 * proper nouns before comparing, so a numbered fixture collapses to ONE key and every batch
 * looks uniform. The first draft of this file did exactly that and three tests failed on the
 * fixture rather than on the code.
 */
const question = (i: number) => [
  'Is that something you are working on?',
  'Would a steadier flow of enquiries help?',
  'Does that match what you are seeing?',
  'Worth a short conversation?',
  'Is the diary the constraint at the moment?',
  'Are you looking at that for next quarter?',
  'Does that land anywhere near the mark?',
  'Would it help to have that running in the background?',
  'Is that a problem you have already solved?',
  'Any appetite to change that?',
  'Has that come up for you?',
  'Is that worth fixing this year?',
][i % 12]

const varied = (i: number) => [
  'Referral flow arrives when it arrives and stops when it stops.',
  'A quiet month shows up in the diary two months later.',
  'Nobody is prospecting while the founder is billing.',
  'The next project has to start before the current one ends.',
  'Growth stalls at the point the founder runs out of hours.',
  'An empty pipeline is invisible right up until it is not.',
  'Every hour on delivery is an hour off business development.',
  'Word of mouth cannot be scheduled.',
  'The diary looks full until the work lands.',
  'Capacity and demand rarely peak together.',
][i % 10]

describe('a batch converging on one phrase is flagged', () => {
  it('THE FAILURE IT WAS BUILT FOR: eleven of twelve bridges on one skeleton', () => {
    const rows = shipped(12, i => (i < 11 ? SHARED : varied(i)), question)
    const flagged = overusedPhrases(rows, 12)
    expect(flagged.length).toBeGreaterThan(0)
    expect(flagged[0].kind).toBe('bridge')
    expect(flagged[0].used).toBe(11)
    expect(flagged[0].share).toBeCloseTo(11 / 12)
    expect(flagged[0].prospect_ids).toHaveLength(3)
  })

  it('catches a repeated closing question as well as a bridge', () => {
    const rows = shipped(10, i => varied(i), () => 'Is that something you are working on?')
    const flagged = overusedPhrases(rows, 10)
    expect(flagged.some(f => f.kind === 'question')).toBe(true)
  })
})

describe('ordinary convergence is NOT flagged, which is the point of the change', () => {
  it('two of twenty sharing a bridge passes, because that is 10% and the test is strictly greater', () => {
    const rows = shipped(20, i => (i < 2 ? SHARED : varied(i)), question)
    expect(overusedPhrases(rows, 20)).toEqual([])
  })

  it('three of twenty does flag, so the threshold is real and not simply never reached', () => {
    const rows = shipped(20, i => (i < 3 ? SHARED : varied(i)), question)
    const flagged = overusedPhrases(rows, 20)
    expect(flagged.some(f => f.used === 3)).toBe(true)
  })

  it('a phrase used ONCE is never flagged, whatever the batch size', () => {
    const rows = shipped(3, i => varied(i), question)
    expect(overusedPhrases(rows, 3)).toEqual([])
    // POSITIVE CONTROL: the same three rows DO flag when they share a bridge, so the empty
    // result above is the threshold working and not the function failing to see anything.
    const same = shipped(3, () => SHARED, question)
    expect(overusedPhrases(same, 3).length).toBeGreaterThan(0)
  })
})

describe('the denominator is the batch, not the survivors', () => {
  it('two shipped out of twenty is not a uniform batch, however identical the two are', () => {
    const rows = shipped(2, () => SHARED, question)
    // Both shipped rows are identical, so counted against themselves this would be 100%.
    expect(overusedPhrases(rows, 2).length).toBeGreaterThan(0)
    // Against the real batch of twenty it is 10%, which is not over the threshold.
    expect(overusedPhrases(rows, 20)).toEqual([])
  })

  it('a zero or negative batch size returns nothing rather than dividing by it', () => {
    expect(overusedPhrases(shipped(2, () => SHARED, question), 0)).toEqual([])
    expect(overusedPhrases([], 10)).toEqual([])
  })
})

describe('the threshold is one constant', () => {
  it('is exported, so disagreeing with it is a one-line change', () => {
    expect(OVERUSE_FRACTION).toBe(0.10)
  })
})
