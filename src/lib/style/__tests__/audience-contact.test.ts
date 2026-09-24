// PROMISING TO REACH AN AUDIENCE THE PROSPECT ALREADY HAS.
//
// Promoted out of an analysis script on 2026-09-24. For two full runs it was measured and
// could not act: it appeared in no gate, no test and no production path. A check that lives
// only in a report cannot fail anything.
//
// Fixtures are industry-neutral and none is copied from any client's document.

import { describe, it, expect } from 'vitest'
import { findAudienceContactClaims, audienceContactFeedback } from '../audience-contact'

describe('promising to reach an audience they already have', () => {
  it('rejects a promise to contact their own followers', () => {
    const hits = findAudienceContactClaims('We can reach your subscribers with the same message.')
    expect(hits).toHaveLength(1)
    expect(hits[0].matched).toBe('your subscribers')
  })

  it('needs BOTH halves: an audience of theirs AND the sender reaching it', () => {
    // POSITIVE CONTROL ON THE CONJUNCTION. Either half alone is ordinary copy, and a gate
    // firing on one of them would reject any sentence that mentions their readers at all.
    expect(findAudienceContactClaims('Your subscribers already know the name.')).toEqual([])
    expect(findAudienceContactClaims('We reach buyers who have not met you.')).toEqual([])
  })

  it('rejects a claim about who has NOT consumed their content', () => {
    // The same fault from the other side: who they have not reached is not knowable from
    // outside their own analytics.
    const hits = findAudienceContactClaims('The buyers who never read that post do not know the firm exists.')
    expect(hits).toHaveLength(1)
    expect(hits[0].matched).toBe('who never read')
  })

  it('needs a pointer at their content, so ordinary sentences about buyers pass', () => {
    expect(findAudienceContactClaims('The buyers who never heard of the firm are the ones worth reaching.')).toEqual([])
  })

  it('the feedback names the offending text rather than the rule', () => {
    const hits = findAudienceContactClaims('We can reach your subscribers with the same message.')
    const msg = audienceContactFeedback(hits)
    expect(msg).toContain('your subscribers')
    expect(msg).toContain('people who have NOT heard of them')
  })

  it('says nothing about empty or ordinary text', () => {
    expect(findAudienceContactClaims('')).toEqual([])
    expect(findAudienceContactClaims('You opened a second site in March.')).toEqual([])
  })
})
