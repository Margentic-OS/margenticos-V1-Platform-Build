// THE ASSUMED-CAPACITY DETECTOR, both ways.
//
// Every BANNED case is paired with the nearest PERMITTED one, because the two families are
// built from the same words and a detector that cannot tell them apart is an outage. The
// permitted cases are the ones that would cost real emails if this ever moves to blocking
// on per-prospect copy.
//
// RULE ZERO: no fixture here names a client, an industry, a service or a buyer title. The
// shapes are the shapes of an assumption about a reader, and they are the same in any market.

import { describe, it, expect } from 'vitest'
import { findAssumedCapacityClaims, assumedCapacityFeedback } from '../assumed-capacity'

const hit = (s: string) => findAssumedCapacityClaims(s)

describe('claims about the reader\'s time', () => {
  it.each([
    ["a new hire's first weeks run on your time.", 'your time'],
    ['That is a long time to carry both delivery and the next search at once.', 'to carry both'],
    ['The weeks your calendar fills are weeks nothing else moves.', 'your calendar'],
    ['A second role takes the hours your pipeline would otherwise have.', 'the hours your'],
    ['The next search waits for a gap in your diary.', 'your diary'],
    ['You are too busy to keep it running.', 'busy'],
    ['You do not have the time to keep it running.', 'have the time'],
  ])('flags %s', (sentence) => {
    const hits = hit(sentence)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].kind).toBe('their_time')
  })

  it.each([
    // ABOUT THE SENDER, not the reader.
    'We keep it running so the next meetings are booked before the current work ends.',
    // ABOUT THE EVENT, not the reader.
    'Capacity is being added before the work that pays for it is booked.',
    'A panel puts the firm in front of a room it has not met.',
    // ORDINARY TIME WORDS with no claim attached to the reader.
    'The weeks after a launch are when the first enquiries arrive.',
    'Revenue that was predictable has ended.',
    'You spoke on a panel on August 10.',
  ])('leaves alone: %s', (sentence) => {
    expect(hit(sentence)).toEqual([])
  })
})

describe('claims about who does the selling', () => {
  it.each([
    'No prospecting on your end.',
    'You do not touch the prospecting.',
    'You are doing all the outreach yourself.',
    'He is the one doing all the client-facing work.',
    'They are the only person responsible for pipeline.',
    'The founder runs the outbound.',
    'It builds without you chasing.',
  ])('flags %s', (sentence) => {
    const hits = hit(sentence)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some(h => h.kind === 'who_sells')).toBe(true)
  })

  it.each([
    // WHAT THE SENDER DOES. The offer line has to be able to say this.
    'We run outbound so meetings land in the diary.',
    'The prospecting gets done whether or not anyone is free.',
    // AN EVENT ABOUT A ROLE, not a claim about who sells.
    'A business development hire started in March.',
    'Whoever was generating conversations has left.',
  ])('leaves alone: %s', (sentence) => {
    expect(hit(sentence)).toEqual([])
  })
})

// ─── THE MEASURED MISSES, 2026-09-23 ─────────────────────────────────────────
//
// The first trigger-reason derivation passed this detector with ZERO faults and produced
// three reasons that plainly broke the rule. Every pattern at that point was about the
// READER doing the selling; none was about a NAMED ROLE doing it, about who used to hold
// the job, or about the selling stopping. These are those three, verbatim in shape, with
// the reasons from the same run that were correct as the control.
describe('claims about a named role, or about the selling stopping', () => {
  it.each([
    'A major engagement starting or ending means the founder re-enters delivery and pipeline stops.',
    'Promoting delivery people into client-facing roles shifts them away from generating new pipeline.',
    'The person who owned outbound is gone, so pipeline generation has no operator.',
    'Whoever ran the prospecting has moved on.',
    'The owner goes back into delivery when a project lands.',
  ])('flags %s', (sentence) => {
    expect(hit(sentence)).not.toEqual([])
  })

  it.each([
    // FROM THE SAME RUN, and correct. These are what a passing reason looks like, so a
    // widening that broke them would be caught here rather than by reading output.
    'More delivery capacity means more client slots to fill with new pipeline.',
    'A new offer needs its own pipeline of qualified conversations to generate revenue.',
    'Visibility generates inbound interest that needs outbound follow-through to convert into meetings.',
    'New credentials strengthen outbound messaging but only create pipeline if used in active outreach.',
    'Lost recurring revenue creates an immediate gap that requires new conversations to fill.',
    'Third-party recognition is a credibility anchor that makes cold outreach convert at higher rates.',
  ])('leaves alone: %s', (sentence) => {
    expect(hit(sentence)).toEqual([])
  })
})

// SECOND WIDENING, same day, same method: run the derivation, read the output, find what
// the gate let through. These four came from the run after the first widening.
describe('a role\'s attention, who brings the work in, and being the only one on it', () => {
  it.each([
    "A major engagement starting or ending resets the founder's attention away from pipeline.",
    'Promoting from within shifts a delivery person out, changing who generates new business.',
    'The departure removes the only dedicated pipeline function from the firm.',
    "Full-time commitment requires revenue growth the founder's network alone cannot deliver.",
    "The owner's diary decides when it happens.",
    'It changes who wins the work.',
  ])('flags %s', (sentence) => {
    expect(hit(sentence)).not.toEqual([])
  })

  it.each([
    'New brand assets need outbound distribution to reach prospects who will not find them organically.',
    'Visibility without outbound creates inbound interest but no systematic way to convert it.',
    'New credibility proof strengthens outbound messaging but only works if outbound is running.',
    'Third-party validation is a credibility anchor that makes cold outreach convert higher.',
  ])('leaves alone: %s', (sentence) => {
    expect(hit(sentence)).toEqual([])
  })
})

describe('counting', () => {
  it('counts a sentence ONCE per kind, however many ways it is phrased', () => {
    // Three time patterns in one sentence is one fault, not three: counting each would make
    // the report look worse the more elaborately the same assumption was written.
    const hits = hit('Your week and your diary and your calendar are full.')
    expect(hits.filter(h => h.kind === 'their_time')).toHaveLength(1)
  })

  it('reports both kinds when a sentence makes both claims', () => {
    const hits = hit('You do the prospecting yourself in whatever time your week leaves.')
    expect(new Set(hits.map(h => h.kind))).toEqual(new Set(['their_time', 'who_sells']))
  })

  it('finds a hit in any sentence, not only the first', () => {
    expect(hit('An event happened on a date. Your diary is the constraint.')).toHaveLength(1)
  })

  it('empty and whitespace return nothing rather than throwing', () => {
    expect(hit('')).toEqual([])
    expect(hit('   ')).toEqual([])
  })
})

describe('the feedback names the text, not the rule', () => {
  it('quotes what matched and says what to do instead', () => {
    const text = assumedCapacityFeedback(hit('Your diary is the constraint.'))
    // QUOTED AS WRITTEN, capital included. Lower-casing the quote would be tidier to read
    // and would stop it being findable in the text it came from, which is the point of
    // quoting it at all.
    expect(text).toContain('"Your diary"')
    expect(text).toMatch(/nothing about the reader's time or their staffing/)
  })

  it('does not repeat the same quote twice', () => {
    const text = assumedCapacityFeedback([
      { kind: 'their_time', matched: 'your time', sentence: 'a' },
      { kind: 'their_time', matched: 'your time', sentence: 'b' },
    ])
    expect(text.match(/"your time"/g)).toHaveLength(1)
  })
})
