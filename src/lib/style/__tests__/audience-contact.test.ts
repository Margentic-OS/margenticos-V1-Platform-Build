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

  it('rejects a claim about who IS or IS NOT in their audience', () => {
    // Measured: an Email 1 shipped "People who would switch ... are not in your LinkedIn
    // feed yet." Only the reader can check it and nobody outside can know it.
    expect(findAudienceContactClaims('The people who would switch are not in your LinkedIn feed yet.')).toHaveLength(1)
    // POLARITY DOES NOT MATTER: the same unknowable claim, stated positively.
    expect(findAudienceContactClaims('The buyers you want are already in your network.')).toHaveLength(1)
    expect(findAudienceContactClaims('Those decision makers sit outside your following.')).toHaveLength(1)
  })

  it('STILL allows the sender reaching people the reader has not met', () => {
    // THE LINE IS EXACTLY HERE. A rule that could not tell these apart would ban the offer,
    // which is the whole thing being sold.
    expect(findAudienceContactClaims('We reach buyers who have never heard of you.')).toEqual([])
    expect(findAudienceContactClaims('The people worth reaching have not met the firm yet.')).toEqual([])
    expect(findAudienceContactClaims('We put that argument in front of buyers who will never scroll past it.')).toEqual([])
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

// ─── 2026-09-25: two real sentences from the 104 that every gate passed ──────────────────

describe('a possessive that is the company name, and a positively-stated audience', () => {
  it('CATCHES a company-name possessive: "already in Covalent’s orbit"', () => {
    const hits = findAudienceContactClaims(
      "Your LinkedIn feed is running entirely toward people already in Covalent's orbit.",
    )
    expect(hits).toHaveLength(1)
    expect(hits[0].matched).toContain('orbit')
  })

  it('CATCHES a positively-stated audience: "whoever already follows you"', () => {
    const hits = findAudienceContactClaims("AGI's post reaches whoever already follows you.")
    expect(hits).toHaveLength(1)
    expect(hits[0].matched).toContain('already follows')
  })

  // ─── SENDER-SIDE REACH STAYS ALLOWED. Without these the gate could be rejecting every
  //     description of the service itself, which is the one thing the copy must be free to say.

  it('ALLOWS sender-side reach: people who have not heard of them', () => {
    expect(findAudienceContactClaims('We reach buyers who have not heard of you yet.')).toEqual([])
  })

  it('ALLOWS sender-side reach: putting them in front of new buyers', () => {
    expect(
      findAudienceContactClaims('We get the argument in front of buyers who have never come across the firm.'),
    ).toEqual([])
  })

  it('ALLOWS an ordinary sentence naming a company possessive without an audience noun', () => {
    expect(findAudienceContactClaims("Covalent's report landed in March.")).toEqual([])
  })

  it('ALLOWS a relative clause with no affirmative adverb', () => {
    expect(findAudienceContactClaims('We contact people who run operations teams.')).toEqual([])
  })
})
