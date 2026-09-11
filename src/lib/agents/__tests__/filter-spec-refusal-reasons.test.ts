// Every refusal names its rule, so the caller can say WHY rather than guess.
//
// persistIcpFilterSpec used to label every refusal "non-canonical industries". The one that
// reached Sentry on 2026-09-08 was a blank headcount. These check that each refusal carries
// the rule that actually fired, on the real function with real inputs.
//
// RULE ZERO: no industry, sector, country or company name below beyond the canonical list.

import { describe, it, expect } from 'vitest'
import {
  deriveFilterSpec,
  FilterSpecRefusal,
  CANONICAL_INDUSTRIES,
  type IcpDocument,
} from '@/lib/agents/icp-filter-spec'
import { seniorityFixture, NO_SENIORITY } from '@/test-utils/seniority-fixture'
import { aGeography } from '@/test-utils/geography-fixture'

function icp(overrides: { headcount?: [string, string]; industry?: string } = {}): IcpDocument {
  const [h1, h2] = overrides.headcount ?? ['5-20 people', '21-50 people']
  const tier = (headcount: string, industry: string) => ({
    company_profile: { revenue_range: '', headcount, industries: [industry] },
    buyer_profile: { title: 'a role this market uses', seniority: 'as the document states it' },
    disqualifiers: [],
  })
  return {
    jtbd_statement: 'j',
    summary: 's',
    tier_1: tier(h1, overrides.industry ?? CANONICAL_INDUSTRIES[0]),
    tier_2: tier(h2, CANONICAL_INDUSTRIES[1]),
    tier_3: { company_profile: { revenue_range: '', headcount: '', industries: [] } },
  } as unknown as IcpDocument
}

function refusalOf(run: () => unknown): FilterSpecRefusal {
  try {
    run()
  } catch (err) {
    expect(err).toBeInstanceOf(FilterSpecRefusal)
    return err as FilterSpecRefusal
  }
  throw new Error('deriveFilterSpec did not refuse')
}

describe('deriveFilterSpec names the rule that refused', () => {
  it('CONTROL: a sound document is not refused, so the cases below each break one thing', () => {
    expect(() => deriveFilterSpec(icp(), null, aGeography(), seniorityFixture())).not.toThrow()
  })

  it('a blank headcount on both tiers is no_headcount_bound, not an industry problem', () => {
    const refusal = refusalOf(() =>
      deriveFilterSpec(icp({ headcount: ['', ''] }), null, aGeography(), seniorityFixture()))
    expect(refusal.reason).toBe('no_headcount_bound')
  })

  it('placeholder text instead of numbers is no_headcount_bound, the 2026-09-08 case', () => {
    const refusal = refusalOf(() =>
      deriveFilterSpec(
        icp({ headcount: ['[number] to [number] staff', '[number] to [number] staff'] }),
        null, aGeography(), seniorityFixture(),
      ))
    expect(refusal.reason).toBe('no_headcount_bound')
    expect(refusal.message).toMatch(/neither tier establishes a lower headcount bound/)
  })

  it('an industry outside the canonical list is non_canonical_industry', () => {
    const refusal = refusalOf(() =>
      deriveFilterSpec(icp({ industry: 'Not A Canonical Name' }), null, aGeography(), seniorityFixture()))
    expect(refusal.reason).toBe('non_canonical_industry')
  })

  it('no seniority bands is no_seniority_bands', () => {
    const refusal = refusalOf(() => deriveFilterSpec(icp(), null, aGeography(), NO_SENIORITY))
    expect(refusal.reason).toBe('no_seniority_bands')
  })

  it('no countries is no_geography', () => {
    const refusal = refusalOf(() => deriveFilterSpec(icp(), null, aGeography([]), seniorityFixture()))
    expect(refusal.reason).toBe('no_geography')
  })
})
