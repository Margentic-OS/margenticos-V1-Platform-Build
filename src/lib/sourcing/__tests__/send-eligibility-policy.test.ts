// The predicate that stops research running on prospects we already know we cannot email.
//
// Measured 2026-08-25 on the first real queue batch: 12 of 13 prospects had a verdict on
// file marking them unmailable BEFORE research ran, and research ran anyway. $2.56 spent,
// one mailable prospect bought.

import { describe, it, expect } from 'vitest'
import {
  checkResearchEligibility,
  summariseIneligible,
  CATCH_ALL_IS_RESEARCH_WORTHY,
  type VerificationFacts,
} from '../send-eligibility-policy'

const verified = (over: Partial<VerificationFacts> = {}): VerificationFacts => ({
  independent_verified_at: '2026-08-10T12:00:00Z',
  independent_email_status: 'Valid',
  email_send_ineligible_reason: null,
  ...over,
})

describe('the case this exists to stop', () => {
  it('blocks a verified-undeliverable address', () => {
    for (const status of ['Invalid', 'Unknown', 'Grey-listed']) {
      const v = checkResearchEligibility(verified({ independent_email_status: status }))
      expect(v.eligible).toBe(false)
      if (!v.eligible) expect(v.reason).toBe('undeliverable')
    }
  })

  it('blocks a valid address excluded for a non-verification reason', () => {
    // The one real example in the cohort: a Valid address in an excluded country.
    const v = checkResearchEligibility(verified({ email_send_ineligible_reason: 'country_excluded_de' }))
    expect(v.eligible).toBe(false)
    if (!v.eligible) expect(v.reason).toBe('country_excluded')
  })

  it('lets a clean verified address through', () => {
    expect(checkResearchEligibility(verified()).eligible).toBe(true)
  })
})

describe('DECISION 1 — Catch All is policy, not fact, and lives in one constant', () => {
  it('follows the constant rather than a hardcoded rule', () => {
    const v = checkResearchEligibility(verified({ independent_email_status: 'Catch All' }))
    expect(v.eligible).toBe(CATCH_ALL_IS_RESEARCH_WORTHY)
  })

  it('reports catch_all distinctly from undeliverable, so the two can be re-policied apart', () => {
    const v = checkResearchEligibility(verified({ independent_email_status: 'Catch All' }))
    if (!v.eligible) {
      expect(v.reason).toBe('catch_all')
      expect(v.reason).not.toBe('undeliverable')
    }
  })
})

describe('DECISION 2 — no verdict fails closed', () => {
  it('blocks a prospect that has never been verified', () => {
    const v = checkResearchEligibility({
      independent_verified_at: null,
      independent_email_status: null,
      email_send_ineligible_reason: null,
    })
    expect(v.eligible).toBe(false)
    if (!v.eligible) expect(v.reason).toBe('no_verdict')
  })

  // A row can carry a status with no verified_at — that is the shape the manual
  // 2026-08-10 script left behind on some columns. verified_at is the discriminator, so a
  // status alone must not be mistaken for a verdict.
  it('treats a status with no verified_at as no verdict, not as a verdict', () => {
    const v = checkResearchEligibility({
      independent_verified_at: null,
      independent_email_status: 'Valid',
      email_send_ineligible_reason: null,
    })
    expect(v.eligible).toBe(false)
    if (!v.eligible) expect(v.reason).toBe('no_verdict')
  })

  it('reports no_verdict ahead of a country exclusion, because verifying is the next step either way', () => {
    const v = checkResearchEligibility({
      independent_verified_at: null,
      independent_email_status: null,
      email_send_ineligible_reason: 'country_excluded_de',
    })
    if (!v.eligible) expect(v.reason).toBe('no_verdict')
  })
})

describe('an unrecognised status does not silently halt the pipeline', () => {
  // The verifier's vocabulary could grow. A new status is not a reason to stop researching:
  // the send gate downstream is still the last word.
  it('lets an unknown-to-us status through rather than blocking on it', () => {
    expect(checkResearchEligibility(verified({ independent_email_status: 'Deliverable' })).eligible).toBe(true)
  })
})

describe('the operator has to be told what was skipped and why', () => {
  it('counts by reason, commonest first', () => {
    const s = summariseIneligible(['catch_all', 'catch_all', 'catch_all', 'undeliverable', 'no_verdict'])
    expect(s).toBe('3 catch-all domain, 1 verified undeliverable, 1 never verified')
  })

  it('renders the real 2026-08-25 cohort shape', () => {
    // 9 Catch All, 1 Invalid, 1 Unknown, 1 country-excluded, 1 eligible.
    const s = summariseIneligible([
      ...Array(9).fill('catch_all' as const),
      'undeliverable', 'undeliverable', 'country_excluded',
    ])
    expect(s).toContain('9 catch-all domain')
    expect(s).toContain('2 verified undeliverable')
    expect(s).toContain('1 excluded country')
  })
})
