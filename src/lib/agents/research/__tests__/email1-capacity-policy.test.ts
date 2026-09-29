// EMAIL 1 BLOCKS TIME AND MONEY CLAIMS RAW; THE OTHER KINDS STILL NEED A READER ANCHOR.
//
// Operator decision, 2026-09-29, after the two positions drifted apart by accident and were
// then aligned the wrong way. The reasoning lives in assumed-capacity.ts beside
// EMAIL1_RAW_BLOCKING_KINDS; these are the controls that stop it drifting again.
//
// WHY THE DIFFERENCE. The Email 1 bridge sits directly under the reader's own fact, and that
// POSITION does the anchoring the sentence does not: an impersonal claim about hours or money
// directly below a paragraph about this reader's event reads as a claim about them. Offer
// language is not converted by position, so who_sells and they_lack keep the anchor.
//
// TWO PROSPECTS ARE RESTORED HERE AS CONTROLS, 68335f7c and d2f44329. Their stored bridges
// were blocked, then let through when the anchored subset was applied to every kind. Their
// text is NOT reproduced: each fixture below is an invented sentence of the same shape.
//
// RULE ZERO. Every fixture is invented and industry-neutral.

import { describe, it, expect } from 'vitest'
import { checkOpeningGates } from '../write-opening'
import { EMAIL1_RAW_BLOCKING_KINDS } from '@/lib/style/assumed-capacity'

const OBSERVATION = 'You opened a second workshop in March.'
const QUESTION = 'Worth a short call?'

/** Run the real Email 1 gates over one bridge, with no company name in context. */
function gatesFor(bridge: string, companyName: string | null = null): string[] {
  return checkOpeningGates(
    `${OBSERVATION}\n\n${bridge} ${QUESTION}`,
    null,
    `${OBSERVATION} ${bridge}`,
    undefined,
    { observation: OBSERVATION, bridge, question: QUESTION },
    { prospectId: 'email1-capacity-policy', companyName },
  )
}

const capacityFailures = (fs: string[]) => fs.filter(f => f.includes('assumes something about the reader'))

describe('Email 1 blocks an IMPERSONAL time or money claim', () => {
  it('blocks a time claim that names nobody, the 68335f7c shape', () => {
    // No "you", no "your", no firm name. Under the anchored subset this passed.
    const bridge = 'New work is the first thing to lose its slot in a week split across three businesses.'
    expect(capacityFailures(gatesFor(bridge))).not.toEqual([])
  })

  it('blocks a second impersonal time shape, the d2f44329 shape', () => {
    const bridge = 'A long search takes the weeks that would otherwise go toward the next job.'
    expect(capacityFailures(gatesFor(bridge))).not.toEqual([])
  })

  it('blocks an impersonal money claim', () => {
    const bridge = 'A closed engagement leaves the workshop without the revenue it was running beside.'
    expect(capacityFailures(gatesFor(bridge))).not.toEqual([])
  })

  it('CONTROL: a bridge making neither claim passes the capacity gate', () => {
    // Without this, every assertion above would pass just as happily if the gate rejected
    // everything, which is an outage rather than a control.
    const bridge = 'Work of that kind tends to land before the next set of buyers does.'
    expect(capacityFailures(gatesFor(bridge))).toEqual([])
  })
})

describe('the other kinds still need the reader anchor on Email 1', () => {
  it('does NOT block offer language, which position cannot make a claim about the reader', () => {
    // A who_sells hit. It is a promise about what the sender takes over and it is in the
    // client's own approved template, so blocking it would reject the copy the rules ask for.
    const bridge = 'No prospecting on your end once the first month is set up.'
    expect(capacityFailures(gatesFor(bridge))).toEqual([])
  })

  it('names exactly the two kinds that block raw, so a third cannot be added silently', () => {
    expect([...EMAIL1_RAW_BLOCKING_KINDS].sort()).toEqual(['their_money', 'their_time'])
  })
})
