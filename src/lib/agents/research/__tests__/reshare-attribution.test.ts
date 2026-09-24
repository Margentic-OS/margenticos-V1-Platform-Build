// A RESHARE DESCRIBED AS SOMETHING THEY WROTE IS EXCLUDED. One that discloses the reshare
// is kept, however it phrases the disclosure.
//
// FOUND ON A REAL CANDIDATE, 2026-09-24. The first version of this check matched only the
// verb forms "shared" and "reshared", so an observation disclosing the reshare with a NOUN,
// "announced via a reshare of the network's post", was excluded for using "announced"
// beside it. That candidate was a firm's own partner-network news, correctly labelled, and
// it was thrown away by a check meant to catch the opposite mistake.

import { describe, it, expect } from 'vitest'
import { isReshareWrittenAsTheirOwn } from '../synthesize'
import type { ObservationCandidate } from '../types'

const c = (observation: string, is_reshare = true) =>
  ({ observation, is_reshare } as unknown as ObservationCandidate)

describe('an undisclosed reshare is excluded', () => {
  it.each([
    'They posted about the partnership.',
    'She announced the new network membership on 8 July.',
    'He wrote that the firm had joined the programme.',
    'They made the case for the change in a post.',
  ])('excludes: %s', (o) => expect(isReshareWrittenAsTheirOwn(c(o))).toBe(true))
})

describe('a disclosed reshare is kept, in any grammatical form', () => {
  it.each([
    // THE CASE THAT MOTIVATED THIS. The disclosure is a noun, and an authorship verb sits
    // beside it describing what the ORIGINAL post said.
    'The firm joined the network, announced via a reshare of the partner post on 8 July.',
    'They reshared the network announcement.',
    'She shared a job vacancy on 21 August, adding her own thoughts.',
    'A repost of the award announcement went up in June.',
    'They amplified the announcement rather than writing it.',
  ])('keeps: %s', (o) => expect(isReshareWrittenAsTheirOwn(c(o))).toBe(false))
})

describe('the check only applies to reshares at all', () => {
  it('a post of their own is never excluded, whatever verb it uses', () => {
    // POSITIVE CONTROL for the whole suite: without this, a check that excluded EVERYTHING
    // would still pass the first block, and the second block alone cannot tell the
    // difference between "kept because disclosed" and "kept because nothing is checked".
    expect(isReshareWrittenAsTheirOwn(c('They posted about the partnership.', false))).toBe(false)
    expect(isReshareWrittenAsTheirOwn(c('They announced it themselves.', false))).toBe(false)
  })

  it('bare "share" is not a disclosure, because market share is a different word', () => {
    expect(isReshareWrittenAsTheirOwn(c('Their market share grew and they announced it.'))).toBe(true)
  })
})
