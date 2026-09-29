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
import { findAssumedCapacityClaims, assumedCapacityFeedback, isUnambiguousReaderClaim, isSenderSide } from '../assumed-capacity'

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

// THIRD WIDENING, 2026-09-24. The role patterns covered a role MOVING ITSELF and said
// nothing about a role BEING MOVED, or about work LANDING on one. Both are the same claim.
describe('a role being moved into the work, or the work landing on a role', () => {
  it.each([
    'A big project pulls the founder into the work.',
    'That job now falls to the founder.',
    'The work now rests with the owner.',
    'The person who found new deals is gone.',
    // PAST TENSE, every verb. The list was patched twice for a single missing past form
    // before it was written out properly, and "who used to do the job" is the more common
    // shape because the trigger is usually that they left.
    'The person who ran new deals is gone.',
    'The person who led sales has left.',
    'The person who managed the pipeline moved on.',
  ])('flags %s', (sentence) => {
    expect(hit(sentence)).not.toEqual([])
  })

  it.each([
    'More staff means more client work to fill with new deals.',
    'A new offer needs buyers who have not heard of it yet.',
    'New eyes land on the firm but have no next step to take.',
    'A fresh brand needs new people to see it.',
    'Steady income just stopped. New clients are needed now.',
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

// ═══════════════════════════════════════════════════════════════════════════════
// HOW THE READER'S HOURS OR ATTENTION ARE DIVIDED. Added 2026-09-29.
//
// WHY THESE EXIST. Replayed over 56 stored personalised Email 1s the detector scored 6 hits
// and all six were genuine, so its PRECISION looked settled. On the one sentence the
// operator had picked out by hand it scored ZERO, while this file's own positive controls
// fired: the detector worked and simply had no shape for a claim about time being DIVIDED
// between two calls on it. Precision was the half that had been measured; recall was the
// half that decides what a gate is worth.
//
// EVERY FIXTURE BELOW IS INVENTED. The firms and the situations are made up, and the shapes
// are the operator's, restated so no real prospect appears in this repository.
// ═══════════════════════════════════════════════════════════════════════════════

describe('a claim about how the reader\'s hours are divided', () => {
  const fires = (s: string) => findAssumedCapacityClaims(s).length > 0

  it('fires when two things are said to compete for one pool of hours', () => {
    expect(fires("Harbour Lane's next projects compete for the same hours as your second company.")).toBe(true)
    expect(fires('The two roles draw on the same attention every week.')).toBe(true)
  })

  it('fires on a zero-sum trade written as a loss rather than with the word "not"', () => {
    // The pre-existing zero-sum pattern requires "not spent" or "not going", so the same
    // arithmetic written as a loss to the other side was invisible.
    expect(fires('Every hour you spend on the second venture is an hour the first one never gets back.')).toBe(true)
    expect(fires('Each day given to one is a day the other waits.')).toBe(true)
  })

  it('fires on time or attention explicitly divided, in BOTH word orders', () => {
    // The two orders are built from one shared noun list. Written out twice, the second copy
    // lost "days" and "weeks" immediately, and only a control using "the week" caught it.
    expect(fires('Your attention is divided between the two companies.')).toBe(true)
    expect(fires('A founder spread across two firms has less of the week for either.')).toBe(true)
    expect(fires('The week is stretched across both of them.')).toBe(true)
  })

  it('stays silent on a SENDER PROMISE, which is what the service takes over', () => {
    // The operator's own negative control. A promise that the reader stops doing something
    // is an offer, not a claim about their diary, and it is in the approved template.
    expect(fires('You stop chasing the calendar.')).toBe(false)
    expect(fires('We keep the conversations arriving while the current work runs.')).toBe(false)
  })

  it('stays silent on "at the same time", which is the ordinary idiom for simultaneity', () => {
    // A stored observation reported two businesses run "at the same time since 2022". That
    // is a visible fact about what exists, not a claim about how a week is spent, which is
    // why the contention verb is required rather than the phrase alone.
    expect(fires('You have run both businesses as active companies at the same time since 2022.')).toBe(false)
    expect(fires('Both announcements landed at the same time.')).toBe(false)
  })

  it('stays silent where "takes time" is the idiom for slowness', () => {
    expect(fires('That kind of hire takes time to ramp.')).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// WHAT THE READER'S MONEY IS DOING. Added 2026-09-29.
//
// The gap the other checks leave open, measured on the stored cohort: the fact-check can pass
// a money claim when a finding mentions the event behind it, and the firmographic rule bans
// FIGURES, so a claim carrying no number goes straight through. Two stored Email 1s shipped
// one. They are referred to here by prospect id and their text is NOT reproduced; every
// fixture below is an invented sentence of the same shape.
//
// NO AMOUNT APPEARS IN ANY PATTERN. Numbers are the firmographic rule's job.
// ═══════════════════════════════════════════════════════════════════════════════

describe('a claim about the reader\'s money', () => {
  const fires = (s: string) => findAssumedCapacityClaims(s).some(h => h.kind === 'their_money')

  it('fires on the ABSENCE shape, which is what both stored examples were', () => {
    // Prospects 1b2a2796 and 6835f6e6. Invented equivalents, same grammar.
    expect(fires('The Delivery Company now needs to win new clients without a second income behind it.')).toBe(true)
    expect(fires('A closed engagement leaves Kestrel without the revenue it was running beside.')).toBe(true)
  })

  it('fires on a possessive, second person or on a name', () => {
    expect(fires('Your revenue depends on one contract.')).toBe(true)
    expect(fires("Kestrel's billings come from two clients.")).toBe(true)
    expect(fires('Your margins are thinner than they were.')).toBe(true)
  })

  it('stays silent on a NEUTRAL mention of a fee, a price or a cost', () => {
    // The operator's negative control. A number on an offer is something anyone may mention;
    // what is banned is asserting how much of it THEY have. "price", "pricing", "cost" and
    // "invoice" are deliberately absent from the noun list for this reason.
    expect(fires('The workshop has a fixed fee.')).toBe(false)
    expect(fires('Pricing is published on the site.')).toBe(false)
    expect(fires('That kind of repair costs less than the downtime.')).toBe(false)
    expect(fires('You will get an invoice at the end of the month.')).toBe(false)
  })

  it('stays silent on a SENDER PROMISE about money', () => {
    expect(fires('You pay nothing until a meeting is booked.')).toBe(false)
    expect(fires('We work for a share of what it brings in.')).toBe(false)
  })

  it('stays silent where the event itself is the subject, with no money claim', () => {
    expect(fires('You announced a new product line on 14 August.')).toBe(false)
    expect(fires('A contract ending is the moment the next one has to exist.')).toBe(false)
  })

  // THE SHAPE THE PATTERN CANNOT JUDGE ON ITS OWN, stated rather than hidden. An absence of
  // money in a POPULATION statement is the copy the brief asks for; the same sentence naming
  // this reader is the claim it bans, and the difference is not in the shape. That is what
  // isUnambiguousReaderClaim decides, and why both gates apply it.
  it('DOES fire on a population statement, which is why the caller must anchor it', () => {
    const s = 'Firms without a second income have to replace it faster.'
    expect(fires(s)).toBe(true)
    const [hit] = findAssumedCapacityClaims(s)
    expect(isUnambiguousReaderClaim(hit, [])).toBe(false)
    expect(isUnambiguousReaderClaim(hit, ['Kestrel'])).toBe(false)
    // And the same sentence naming the reader does block.
    const named = findAssumedCapacityClaims('Kestrel is without a second income now.')[0]
    expect(isUnambiguousReaderClaim(named, ['Kestrel'])).toBe(true)
  })
})

describe('the sender exemption names the reader, rather than matching any negation', () => {
  const exempt = (s: string, m: string) => isSenderSide(s, m)

  it('still exempts every shape it was written for', () => {
    expect(exempt('Booked calls land on your calendar without you touching the prospecting side.', 'your calendar')).toBe(true)
    expect(exempt('No prospecting on your end.', 'prospecting')).toBe(true)
    expect(exempt("You don't touch the list building.", 'list')).toBe(true)
    expect(exempt('You stop chasing the calendar.', 'calendar')).toBe(true)
    expect(exempt('We run the outreach and you take the calls.', 'outreach')).toBe(true)
  })

  it('NO LONGER exempts a sentence merely because it contains a negation', () => {
    // It matched a bare `no|never|without|don't|stop` anywhere, so any sentence carrying a
    // negation was read as a sender promise and left the capacity gate entirely. Both stored
    // money-guess bridges were exempted on the word "without".
    expect(exempt('The Delivery Company now needs to win new clients without a second income behind it.', 'without a second income')).toBe(false)
    expect(exempt('A closed engagement leaves Kestrel without the revenue it was running beside.', 'without the revenue')).toBe(false)
    expect(exempt('Your calendar never clears before the next job starts.', 'Your calendar')).toBe(false)
  })
})
