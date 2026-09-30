// A SHORT RELATIVE TIME PHRASE IS BANNED OUTRIGHT, IN EVERY EMAIL.
//
// Not checked against a clock, banned. The four emails go out on days 0, 3, 10 and 17, so a
// phrase can be true when written and false when read, and no single clock guards all four.
// A month or a date is true whenever it lands.
//
// TESTED BOTH WAYS, on the operator's instruction: what must fire, and what must not. The
// second half is the half that matters, because the opt-out footer on every email reads
// "Not for you? Just reply stop."
//
// RULE ZERO. Every fixture is invented and industry-neutral.

import { describe, it, expect } from 'vitest'
import { findShortRelativePhrases, shortRelativeFeedback } from '../short-relative'
import { splitIntoSentences } from '../sentence-count'

const hits = (t: string) => findShortRelativePhrases(t, splitIntoSentences)
const fires = (t: string) => hits(t).length > 0

describe('the banned phrases', () => {
  it('fires on every phrase on the list', () => {
    for (const t of [
      'You published the guide this week.',
      'You spoke at the summit last week.',
      'You posted about it yesterday.',
      'The site went live today.',
      'You recently added a second location.',
      'You just announced the new programme.',
      'You just launched the second unit.',
      'You posted about it this morning.',
      'The results went up last night.',
    ]) expect(fires(t), t).toBe(true)
  })

  it('fires on forward-looking STATEMENTS, which go stale the same way', () => {
    expect(fires('You are speaking at the summit next week.')).toBe(true)
    expect(fires('The programme opens this coming week.')).toBe(true)
  })

  it('does NOT fire inside a question, which re-anchors on the reader\'s own week', () => {
    // The rule exists so the copy is true WHENEVER IT LANDS, and a forward-looking question
    // already is: "this week" in a CTA means the week the reader is in.
    //
    // MEASURED before this exemption: of 13 stored personalised emails carrying a banned
    // phrase, NINE were closing questions of exactly this shape. Banning them would ask for
    // a rewrite of the copy the rule is trying to produce.
    for (const t of [
      'Is a call this week worth twenty minutes?',
      'Is this week a good time to walk through it?',
      'Is thirty minutes this week worth it?',
      'Does that kind of continuity exist in the pipeline today?',
    ]) expect(fires(t), t).toBe(false)
  })

  it('still fires on the STATEMENT version of the same phrase', () => {
    // The control for the exemption. Without it, "questions are exempt" would pass just as
    // happily if the whole rule had stopped working.
    expect(fires('A call this week would be worth twenty minutes.')).toBe(true)
    expect(fires('You published the guide this week.')).toBe(true)
  })

  it('names the phrase and asks for a month or a date', () => {
    const [h] = hits('You published the guide this week.')
    const msg = shortRelativeFeedback(h)
    expect(msg).toContain('"this week"')
    expect(msg).toContain('Name the month or the date instead')
  })

  it('counts one fault per sentence, however many ways it is phrased', () => {
    expect(hits('You just announced it this week.')).toHaveLength(1)
  })
})

describe('what must NOT fire, which is the half that matters', () => {
  it('leaves the opt-out footer alone', () => {
    // Every email carries this. A bare "just" would reject all four.
    expect(fires('Not for you? Just reply stop.')).toBe(false)
  })

  it('leaves "just" in its ordinary sense alone', () => {
    expect(fires('Just a short call, twenty minutes.')).toBe(false)
    expect(fires('It is just the two of them running it.')).toBe(false)
    expect(fires('We just need the go-ahead.')).toBe(false)
  })

  it('leaves a MONTH or a DATE alone, which is what the rule asks for', () => {
    // These are the replacement, so a rule that rejected them would have nothing to offer.
    expect(fires('You published the guide in September.')).toBe(false)
    expect(fires('You published the guide on 14 September.')).toBe(false)
    expect(fires('You published the guide last month.')).toBe(false)
    expect(fires('You published the guide this month.')).toBe(false)
    expect(fires('You published the guide earlier this year.')).toBe(false)
  })

  it('leaves ordinary copy alone', () => {
    expect(fires('You opened a second workshop and the first one is full.')).toBe(false)
    expect(fires('Worth a short call?')).toBe(false)
    expect(fires('')).toBe(false)
  })
})
