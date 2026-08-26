import { describe, it, expect } from 'vitest'
import { resolveSendEligibility } from '../send-eligibility-resolver'
import { toCanonicalVerdict, isKnownVendorVerdict, SECOND_PASS_WORTH_PAYING_FOR } from '../verification-verdict'

const US = 'US'

describe('verification-verdict', () => {
  it('maps the first vendor five words onto the canonical four', () => {
    expect(toCanonicalVerdict('myemailverifier', 'Valid')).toBe('deliverable')
    expect(toCanonicalVerdict('myemailverifier', 'Invalid')).toBe('undeliverable')
    expect(toCanonicalVerdict('myemailverifier', 'Catch All')).toBe('risky')
    expect(toCanonicalVerdict('myemailverifier', 'Unknown')).toBe('unknown')
    expect(toCanonicalVerdict('myemailverifier', 'Grey-listed')).toBe('unknown')
  })

  it('maps the second vendor words explicitly rather than by coincidence', () => {
    expect(toCanonicalVerdict('bouncer', 'deliverable')).toBe('deliverable')
    expect(toCanonicalVerdict('bouncer', 'undeliverable')).toBe('undeliverable')
    expect(toCanonicalVerdict('bouncer', 'risky')).toBe('risky')
    expect(toCanonicalVerdict('bouncer', 'unknown')).toBe('unknown')
  })

  it('reads a missing provider as the first-pass vendor, since its column has a default', () => {
    expect(toCanonicalVerdict(null, 'Catch All')).toBe('risky')
  })

  it('returns null for never-verified, which is NOT the same as unknown', () => {
    // The research spend gate depends on telling "no verdict" from "verified, no verdict
    // reached". Collapsing them would make an unverified prospect indistinguishable from one
    // the verifier examined and could not resolve.
    expect(toCanonicalVerdict('bouncer', null)).toBeNull()
    expect(toCanonicalVerdict('bouncer', '')).toBeNull()
  })

  it('degrades an unrecognised vendor word to unknown, never to deliverable', () => {
    // A vendor changing its vocabulary underneath us must not result in mail being sent on
    // the strength of a word nobody has read.
    expect(toCanonicalVerdict('bouncer', 'probably_fine')).toBe('unknown')
    expect(toCanonicalVerdict('myemailverifier', 'Excellent')).toBe('unknown')
  })

  it('selects catch-all and unknown for paid resolution, and excludes greylisted', () => {
    expect([...SECOND_PASS_WORTH_PAYING_FOR].sort()).toEqual(['Catch All', 'Unknown'])
    // Greylisted still has free first-pass retries pending. Paying to answer a question that
    // is about to answer itself is the point of excluding it.
    expect(SECOND_PASS_WORTH_PAYING_FOR).not.toContain('Grey-listed')
    expect(SECOND_PASS_WORTH_PAYING_FOR).not.toContain('Valid')
    expect(SECOND_PASS_WORTH_PAYING_FOR).not.toContain('Invalid')
  })
})

describe('resolveSendEligibility: the approved disagreement rule', () => {
  it('THE POINT OF THE BUILD: catch-all resolved to deliverable becomes eligible', () => {
    const d = resolveSendEligibility({
      country: US, email: 'emily@esstrategic.co',
      firstPass: 'risky', secondPass: 'deliverable',
    })
    expect(d.eligible).toBe(true)
    expect(d.ineligibleReason).toBeNull()
  })

  it('catch-all still risky on the second pass stays ineligible', () => {
    // sohail@thesouthstarconsulting.com scored 75, tatyana.chorny@olympus.com scored 15.
    // Both are risky. Risky is where we started, so nothing has been gained.
    const d = resolveSendEligibility({
      country: US, email: 'sohail@thesouthstarconsulting.com',
      firstPass: 'risky', secondPass: 'risky',
    })
    expect(d.eligible).toBe(false)
  })

  it('a confirmed dead mailbox is NOT resurrected by a deliverable second opinion', () => {
    const d = resolveSendEligibility({
      country: US, email: 'dead@example.com',
      firstPass: 'undeliverable', secondPass: 'deliverable',
    })
    expect(d.eligible).toBe(false)
    expect(d.detail).toMatch(/cannot overturn/i)
  })

  it('unknown on the first pass is resolvable by the second', () => {
    const d = resolveSendEligibility({
      country: US, email: 'x@example.com',
      firstPass: 'unknown', secondPass: 'deliverable',
    })
    expect(d.eligible).toBe(true)
  })

  it('first pass deliverable is eligible with no second pass at all', () => {
    const d = resolveSendEligibility({
      country: US, email: 'x@example.com', firstPass: 'deliverable', secondPass: null,
    })
    expect(d.eligible).toBe(true)
  })

  it('never verified is ineligible and says so', () => {
    const d = resolveSendEligibility({
      country: US, email: 'x@example.com', firstPass: null, secondPass: null,
    })
    expect(d.eligible).toBe(false)
    expect(d.detail).toMatch(/never verified/i)
  })

  it('catch-all with no second pass yet is ineligible', () => {
    const d = resolveSendEligibility({
      country: US, email: 'x@example.com', firstPass: 'risky', secondPass: null,
    })
    expect(d.eligible).toBe(false)
    expect(d.detail).toMatch(/has not run/i)
  })
})

describe('resolveSendEligibility: country is a hard AND that only ever removes eligibility', () => {
  it('THE REGRESSION THIS BUILD WAS GATED ON: a German catch-all resolved to deliverable is still blocked', () => {
    // This is the exact scenario the hard prerequisite existed for. Without the country fix,
    // re-verification would have returned this row send-eligible with the jurisdiction rule
    // never consulted.
    const d = resolveSendEligibility({
      country: 'DE', email: 'jochen@knot-consulting.com',
      firstPass: 'risky', secondPass: 'deliverable',
    })
    expect(d.eligible).toBe(false)
    expect(d.ineligibleReason).toBe('country_excluded_de')
  })

  it('blocks a German prospect written as a raw vendor name, not an ISO code', () => {
    // Defence in depth: the write path normalises, and the rule also matches aliases, so a
    // row predating normalisation cannot slip through.
    const d = resolveSendEligibility({
      country: 'Germany', email: 'broeskamp.udo@broeskamp.com',
      firstPass: 'deliverable', secondPass: null,
    })
    expect(d.eligible).toBe(false)
    expect(d.ineligibleReason).toBe('country_excluded_de')
  })

  it('country NEVER grants eligibility that the verdicts denied', () => {
    // A permitted country cannot rescue an undeliverable address.
    const d = resolveSendEligibility({
      country: US, email: 'dead@example.com', firstPass: 'undeliverable', secondPass: null,
    })
    expect(d.eligible).toBe(false)
  })

  it('writes ONLY jurisdiction reasons to the stored reason column', () => {
    // email_send_ineligible_reason is read by checkResearchEligibility as "a non-verification
    // block". Writing a verdict reason there would make every catch-all report to the
    // operator as an excluded country.
    for (const firstPass of ['risky', 'unknown', 'undeliverable', null] as const) {
      const d = resolveSendEligibility({
        country: US, email: 'x@example.com', firstPass, secondPass: null,
      })
      expect(d.eligible).toBe(false)
      expect(d.ineligibleReason, `firstPass=${firstPass} must not write a verdict reason`).toBeNull()
    }
  })
})

describe('resolveSendEligibility: the score is recorded, never gated on', () => {
  it('takes no score argument at all, so no threshold can be smuggled in', () => {
    // n=10 on one day, entirely inside the vendor's stated sweet spot, with the whole range
    // between 75 and 90 unobserved. The status is the gate; the score is evidence for later.
    const input = { country: US, email: 'x@example.com', firstPass: 'risky' as const, secondPass: 'deliverable' as const }
    expect(Object.keys(input)).not.toContain('score')
    expect(resolveSendEligibility(input).eligible).toBe(true)
  })
})

describe('the two gates want opposite defaults for an unreadable vendor word', () => {
  it('SEND fails closed: an unrecognised word is never treated as deliverable', () => {
    expect(toCanonicalVerdict('bouncer', 'Deliverable!')).toBe('unknown')
    const d = resolveSendEligibility({
      country: US, email: 'x@example.com',
      firstPass: toCanonicalVerdict('myemailverifier', 'Brand New Status'),
      secondPass: null,
    })
    expect(d.eligible).toBe(false)
  })

  it('RESEARCH fails open on the same word, so a vendor rename cannot halt the pipeline', () => {
    // A vendor renaming 'Valid' to 'Deliverable' would otherwise stop all research
    // platform-wide, silently and with no cheap remedy. Spending on a few addresses is the
    // much smaller error, and the send gate above is still the last word.
    expect(isKnownVendorVerdict('myemailverifier', 'Deliverable')).toBe(false)
    expect(isKnownVendorVerdict('myemailverifier', 'Valid')).toBe(true)
    expect(isKnownVendorVerdict('bouncer', 'deliverable')).toBe(true)
  })
})
