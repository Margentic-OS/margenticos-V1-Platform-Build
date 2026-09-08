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
  suppressed: false,
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

  // ═══════════════════════════════════════════════════════════════════════════
  // SUPPRESSION. Three of these are the production rows from 2026-09-08.

  it('reports a suppressed prospect as unsendable EVEN THOUGH the eligibility column says yes', () => {
    // THE DEFECT, EXACTLY AS IT SHIPPED. Two prospects who replied `stop` in August and one
    // stopped by an operator on the morning of 2026-09-08 all read "Can be emailed: Yes",
    // and all three sat inside the tier counts an operator plans campaign volume from.
    //
    // This is the combination that matters and it is not a corner case: it is the NORMAL
    // state after any stop, because nothing writes email_send_eligible at stop time.
    expect(whyNotSendable({ ...VERIFIED, suppressed: true, email_send_eligible: true }))
      .toBe('suppressed')
  })

  it('mirrors applySendGate: a row the gate refuses is never reported as sendable', () => {
    // The gate requires suppressed = false AND email_send_eligible = true. Reading only the
    // second is a DIFFERENT predicate, not a weaker one, and it says yes where the gate
    // says no. If this ever passes again with the suppression guard removed, the screen has
    // gone back to answering a question nobody asked.
    const gateWouldRefuse = { ...VERIFIED, suppressed: true }
    expect(whyNotSendable(gateWouldRefuse)).not.toBeNull()
  })

  it('reports suppression as ITS OWN reason, not folded into a verification verdict', () => {
    // OPERATOR_HOLD_REASON exists because two readers once treated any non-null ineligible
    // reason as a country exclusion, and the column could not then record a second kind of
    // block without both misreporting it. Folding "they asked us to stop" into "the address
    // does not exist" would repeat that, and an operator cannot act on the difference if the
    // screen has already thrown it away.
    const reason = whyNotSendable({ ...VERIFIED, suppressed: true })
    expect(reason).toBe('suppressed')
    expect(reason).not.toBe('undeliverable')
    expect(reason).not.toBe('unconfirmable')
    expect(reason).not.toBe('no_reason_recorded')
    expect(reason).not.toBe('operator_hold')
  })

  it('prefers suppression over an operator hold when the row carries both', () => {
    // Reachable: a stop writes send_hold_at, and the NEXT verification materialises
    // operator_hold into the ineligible-reason column. Both are true. Suppression is the one
    // the gate acts on today rather than after a re-verification, so it is the honest answer.
    expect(whyNotSendable({
      ...VERIFIED,
      suppressed: true,
      email_send_eligible: false,
      email_send_ineligible_reason: 'operator_hold',
    })).toBe('suppressed')
  })

  it('does not treat a null suppression flag as suppressed', () => {
    // The column is NOT NULL in the schema, but the type admits null and a null must not
    // silently remove someone from a campaign count.
    expect(whyNotSendable({ ...VERIFIED, suppressed: null })).toBeNull()
  })

  it('has operator-facing wording for suppression that names no vendor, country or client', () => {
    expect(NOT_SENDABLE_LABELS.suppressed).toBe('Stopped, not to be contacted')
    expect(NOT_SENDABLE_LABELS.suppressed).not.toMatch(
      /\b(AU|CA|DE|Germany|Instantly|Apollo|Lemlist|Taplio|Bouncer|MyEmailVerifier)\b/i,
    )
  })

  it('reports an operator hold as a HOLD, not as an excluded country', () => {
    // Three live rows were held by hand with no reason recorded, because the only reason
    // this column could carry meant "country". An operator reading the pipeline screen has
    // to be able to tell a legal rule from a colleague's decision.
    const reason = whyNotSendable({
      ...VERIFIED,
      email_send_eligible: false,
      email_send_ineligible_reason: 'operator_hold',
    })
    expect(reason).toBe('operator_hold')
    expect(reason).not.toBe('excluded_country')
  })

  it('has operator-facing wording for the hold that names no country', () => {
    expect(NOT_SENDABLE_LABELS.operator_hold).toBe('Held by an operator')
    expect(NOT_SENDABLE_LABELS.operator_hold).not.toMatch(/\b(AU|CA|DE|Australia|Canada|Germany)\b/)
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
