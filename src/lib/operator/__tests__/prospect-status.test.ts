// The three status readings the pipeline screen depends on.
//
// Every test here is written against the thing that PRODUCES the value, not against a
// fixture copied from it, wherever that is possible. A parser tested only on hand-written
// strings passes forever while the producer moves underneath it, and the failure mode is
// silent: every row falls through to "unrecognised" and the screen goes back to showing an
// opaque code.

import { describe, it, expect } from 'vitest'
import {
  whyNotSendable,
  parseTieringReason,
  readVerificationFailure,
  NOT_SENDABLE_LABELS,
  DISQUALIFIER_LABELS,
  VERIFICATION_MAX_ATTEMPTS,
  type SendabilityFacts,
} from '../prospect-status'
import { REMOVAL_REASONS } from '@/lib/sourcing/tier-classification'

const VERIFIED: SendabilityFacts = {
  email_send_eligible: true,
  email_send_ineligible_reason: null,
  independent_verified_at: '2026-09-01T00:00:00Z',
  independent_email_status: 'Valid',
  verification_provider: 'myemailverifier',
  second_pass_status: null,
  second_pass_provider: null,
}

describe('whyNotSendable', () => {
  it('says nothing is wrong when the send gate would send', () => {
    expect(whyNotSendable(VERIFIED)).toBeNull()
  })

  it('reads the MATERIALISED column, because that is what the send path reads', () => {
    // The send gate reads email_send_eligible and nothing else. A prospect whose raw
    // verdict looks fine but whose column says false is NOT sendable, and reporting it as
    // sendable would be reporting a number that does not describe what will happen.
    expect(whyNotSendable({ ...VERIFIED, email_send_eligible: false })).not.toBeNull()
  })

  it('buckets the country rule WITHOUT naming the country', () => {
    const reason = whyNotSendable({
      ...VERIFIED,
      email_send_eligible: false,
      email_send_ineligible_reason: 'country_excluded_de',
    })
    expect(reason).toBe('excluded_country')
    // RULE ZERO. The stored code names a country; the label must not. Asserted as a
    // standalone token rather than a substring: "excluded" contains "de", and a substring
    // check here fails on correct copy, which is a test that trains you to ignore it.
    const label = NOT_SENDABLE_LABELS[reason!]
    expect(label).toBe('Excluded country')
    expect(label).not.toContain('country_excluded_de')
    expect(label).not.toMatch(/\b[a-z]{2}\b/i)
  })

  it('distinguishes never-verified from verified-and-refused', () => {
    expect(whyNotSendable({
      ...VERIFIED, email_send_eligible: false,
      independent_verified_at: null, independent_email_status: null,
    })).toBe('not_verified')

    expect(whyNotSendable({
      ...VERIFIED, email_send_eligible: false, independent_email_status: 'Invalid',
    })).toBe('undeliverable')
  })

  it('reports an unconfirmable address as unconfirmable, not as dead', () => {
    // The distinction is commercial: one is a confirmed absence, the other is missing
    // information, and they lead to different next actions.
    expect(whyNotSendable({
      ...VERIFIED, email_send_eligible: false, independent_email_status: 'Catch All',
    })).toBe('unconfirmable')
  })

  it('prefers the NEWER verdict when the paid second pass has run', () => {
    expect(whyNotSendable({
      ...VERIFIED,
      email_send_eligible: false,
      independent_email_status: 'Catch All',
      second_pass_provider: 'bouncer',
      second_pass_status: 'undeliverable',
    })).toBe('undeliverable')
  })

  it('THE 21-ROW CASE: ineligible with nothing recorded is reported, not hidden', () => {
    // Measured on production 2026-09-02: 21 of the 24 unsendable tiered prospects carry no
    // reason at all, because email_send_ineligible_reason is only ever written by the
    // country rule. Folding those into a neighbouring bucket would invent an explanation.
    expect(whyNotSendable({
      ...VERIFIED,
      email_send_eligible: false,
      independent_email_status: 'Valid',
    })).toBe('no_reason_recorded')
  })
})

describe('parseTieringReason', () => {
  it('parses the exact string classifyTier writes for a kept prospect', () => {
    const verdict = parseTieringReason('tier_1 (score 100): industry 45, seniority 35, headcount 20')
    expect(verdict).toEqual({
      kind: 'scored',
      tier: 'tier_1',
      score: 100,
      components: [
        { name: 'industry', points: 45 },
        { name: 'seniority', points: 35 },
        { name: 'headcount', points: 20 },
      ],
    })
  })

  it('THE PAIR: every REMOVAL_REASONS member parses as a disqualifier and has a gloss', () => {
    // Reads the producer's own list rather than a copy. A new disqualifier added upstream
    // without a label here fails this test instead of reaching the screen as a raw code.
    for (const reason of REMOVAL_REASONS) {
      expect(parseTieringReason(reason)).toEqual({ kind: 'disqualified', code: reason })
      expect(DISQUALIFIER_LABELS[reason]).toBeTruthy()
    }
  })

  it('RULE ZERO: no gloss names a sector, a country or a threshold', () => {
    for (const label of Object.values(DISQUALIFIER_LABELS)) {
      expect(label).not.toMatch(/consult/i)
      expect(label).not.toMatch(/\d/)
    }
  })

  it('keeps an unrecognised reason visible instead of dropping it', () => {
    // The live data holds 'geography_excluded', which the classifier no longer writes and
    // REMOVAL_REASONS does not list. It must render as itself.
    expect(parseTieringReason('geography_excluded')).toEqual({
      kind: 'unrecognised',
      raw: 'geography_excluded',
    })
  })

  it('treats a malformed breakdown as unrecognised rather than as a partial one', () => {
    // A breakdown missing a component looks complete and is not.
    expect(parseTieringReason('tier_1 (score 100): industry 45, seniority').kind)
      .toBe('unrecognised')
  })

  it('reports a null reason as not-yet-tiered, which is a different fact from removed', () => {
    expect(parseTieringReason(null)).toEqual({ kind: 'not_tiered' })
  })

  it('handles a negative score, because nothing guarantees the scorer stays positive', () => {
    const verdict = parseTieringReason('tier_3 (score -5): industry -25, seniority 20, headcount 0')
    expect(verdict.kind).toBe('scored')
    if (verdict.kind !== 'scored') throw new Error('unreachable')
    expect(verdict.score).toBe(-5)
    expect(verdict.components[0]).toEqual({ name: 'industry', points: -25 })
  })
})

describe('readVerificationFailure', () => {
  it('extracts the status and DISCARDS the sentence, which names a vendor', () => {
    const stored = 'Email verification failed: MyEmailVerifier API returned 429'
    const failure = readVerificationFailure(stored, 3, VERIFICATION_MAX_ATTEMPTS)
    expect(failure).toEqual({ status: 429, attempts: 3, givenUp: true })
    // RULE ZERO, asserted on the actual production string rather than on a sanitised one.
    expect(JSON.stringify(failure).toLowerCase()).not.toContain('myemailverifier')
    expect(JSON.stringify(failure)).not.toContain('API')
  })

  it('says nothing when nothing failed', () => {
    expect(readVerificationFailure(null, 0, VERIFICATION_MAX_ATTEMPTS)).toBeNull()
    expect(readVerificationFailure('   ', 0, VERIFICATION_MAX_ATTEMPTS)).toBeNull()
  })

  it('separates still-retrying from given-up, because they need different actions', () => {
    expect(readVerificationFailure('returned 403', 1, VERIFICATION_MAX_ATTEMPTS)?.givenUp).toBe(false)
    expect(readVerificationFailure('returned 403', 3, VERIFICATION_MAX_ATTEMPTS)?.givenUp).toBe(true)
  })

  it('reports an unparseable error rather than pretending there was no failure', () => {
    const failure = readVerificationFailure('connection reset', 2, VERIFICATION_MAX_ATTEMPTS)
    expect(failure).toEqual({ status: null, attempts: 2, givenUp: false })
  })
})
