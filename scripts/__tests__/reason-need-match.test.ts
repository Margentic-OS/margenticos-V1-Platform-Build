// THE SOURCE FIX: A TRIGGER REASON MUST NAME A NEED THE CLIENT'S OWN DOCUMENT SUPPORTS.
//
// WHY HERE RATHER THAN ONLY ON THE COPY. A reason is written ONCE PER CLIENT and every email
// that client sends argues from it. Measured over 56 stored personalised Email 1s on
// 2026-09-29, one shape accounted for roughly two thirds of all need rejections, and it was
// the same shape every time. Catching that one email at a time is cutting losses; the reason
// is where it enters.
//
// REPLACES reason-quote-verifier.test.ts, which covered a whole-document quote search this
// file no longer has. That search is superseded by the line-scoped citation check, whose own
// controls live in need-matches-offer.test.ts, so the coverage moved rather than went.
//
// RULE ZERO IS THE OTHER HALF. This prompt is shared by every client, so it must describe
// what a REASON has to be and never what any particular client sells.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SYSTEM } from '../derive-trigger-reasons'

const SOURCE = readFileSync(join(process.cwd(), 'scripts/derive-trigger-reasons.ts'), 'utf8')

describe('the derive path uses the shared need-match check', () => {
  it('can find something it is certain about, so a miss below is the code and not the read', () => {
    expect(SOURCE.length).toBeGreaterThan(2000)
    expect(SOURCE).toContain('findEvidenceFaults')
  })

  it('calls checkNeedMatchesOffer against the numbered positioning corpus', () => {
    expect(SOURCE).toContain("from '@/lib/agents/research/need-matches-offer'")
    expect(SOURCE).toContain('checkNeedMatchesOffer({')
    expect(SOURCE).toContain('flattenPositioningText(')
  })

  it('carries no second implementation of "does the document support this"', () => {
    // Two implementations of one question are two things to keep in step, and the one that
    // searched the WHOLE document was the weaker: a quote can be genuine and lifted from a
    // line describing what other providers do.
    expect(SOURCE).not.toContain('checkQuotesAreReal')
    expect(SOURCE).not.toContain('VERIFIER_SYSTEM')
    expect(SOURCE).not.toContain('flattenStrings')
  })

  it('labels a failure as a REASON, never as an email', () => {
    // checkNeedCitations has no default label, and write-followups routes on "email 2" and
    // "email 3". A reason failure inheriting that wording would be routed to an email that
    // does not exist in this run.
    expect(SOURCE).toContain('labelOf: id => `reason ${id}`')
  })
})

describe('Rule Zero: the shared prompt describes a reason, not a service', () => {
  // Words that could only appear if the prompt were describing a particular offer, market or
  // buyer rather than the shape a reason must take. The list is the assertion; the control
  // below proves the matching works, so a zero here is the prompt and not the search.
  const OFFER_WORDS = [
    'outbound', 'cold email', 'cold outreach', 'prospecting', 'pipeline generation',
    'meetings booked', 'qualified meetings', 'consulting firm', 'coaching', 'founder-led',
    'new buyers', 'existing audience', 'followers', 'subscribers', 'site visitors',
    'MargenticOS', 'lead', 'campaign',
  ]

  it('names no service, market or buyer type', () => {
    const found = OFFER_WORDS.filter(w => SYSTEM.toLowerCase().includes(w.toLowerCase()))
    expect(found, `the shared prompt describes an offer: ${found.join(', ')}`).toEqual([])
  })

  it('POSITIVE CONTROL: the same search finds those words when they are present', () => {
    // Without this, a renamed export or an empty string would make the assertion above pass
    // on nothing, which is the failure this repository keeps finding in its own checks.
    const planted = `${SYSTEM}\nThe client runs cold outreach for consulting firm founders.`
    const found = OFFER_WORDS.filter(w => planted.toLowerCase().includes(w.toLowerCase()))
    expect(found).toContain('cold outreach')
    expect(found).toContain('consulting firm')
    expect(SYSTEM.length).toBeGreaterThan(500)
  })

  it('still states the rules a reason must satisfy, which is what it is for', () => {
    expect(SYSTEM).toContain('WHOSE PEOPLE THE NEED IS ABOUT')
    expect(SYSTEM).toContain('FREE OF ANY CLAIM ABOUT WHO DOES THE SELLING')
    expect(SYSTEM).toContain("FREE OF ANY CLAIM ABOUT ANYONE'S TIME")
  })
})
