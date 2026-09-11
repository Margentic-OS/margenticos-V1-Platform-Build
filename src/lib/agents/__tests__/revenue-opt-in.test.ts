// THE REVENUE BAND IS OPT-IN PER CLIENT, AND OFF UNLESS SOMEONE TURNS IT ON.
//
// Measured 2026-09-10 against the sourcing provider: its revenue filter excludes every company
// it holds no revenue figure for, and no request shape keeps them. On one live client's search
// that was 78% of everyone it could reach. So a band is read and stored always, and SENT only
// for a client an operator has opted in; otherwise it is recorded as switched off, with the
// reason, and the handler removes it.
//
// These tests go from the document to the request the provider would receive, because the
// defect this change set closes was a switch-off that was RECORDED and never APPLIED.
//
// RULE ZERO: no industry, sector, country or company name below. The industry comes from the
// exported list by position; every reason is a placeholder.

import { describe, it, expect } from 'vitest'
import {
  deriveFilterSpec, CANONICAL_INDUSTRIES, REVENUE_NOT_OPTED_IN,
  type IcpDocument, type SpecSeniority,
} from '@/lib/agents/icp-filter-spec'
import { buildApolloRequest } from '@/lib/sourcing/handlers/adapter-apollo'
import { aTargetableCode, aGeography } from '@/test-utils/geography-fixture'
import { seniorityFixture } from '@/test-utils/seniority-fixture'

const docWith = (revenue: string): IcpDocument => ({
  summary: 's',
  jtbd_statement: 'j',
  tier_1: {
    company_profile: { revenue_range: revenue, headcount: '5-20 people', industries: [CANONICAL_INDUSTRIES[0]] },
    buyer_profile: { title: 't', seniority: 'as the document states it' },
    disqualifiers: [],
  },
  tier_2: {
    company_profile: { revenue_range: revenue, headcount: '5-20 people', industries: [CANONICAL_INDUSTRIES[0]] },
    buyer_profile: { title: 't', seniority: 'as the document states it' },
    disqualifiers: [],
  },
  tier_3: { company_profile: { revenue_range: 'r', headcount: '5-20 people', industries: [] } },
})
const WITH_BAND = docWith('GBP 1M to 20M')
const NO_BAND = docWith('not stated')

const criterion = () => ({
  status: 'derived' as const,
  accept: [{ fragment: 'a-role-fragment', rank: 'primary' as const }],
  reject: [], statement: 's', evidence: [], unsettled_reason: null, sanity: null,
  derived_at: new Date(0).toISOString(), model: 'test',
})
const geo = () => aGeography([aTargetableCode()])
const derivationSwitchedOff = (reasons: Record<string, string>): SpecSeniority => ({
  ...seniorityFixture(2),
  omitted: Object.keys(reasons) as SpecSeniority['omitted'],
  omittedReasons: reasons,
})
const sent = (spec: object) => buildApolloRequest(spec as unknown as Record<string, unknown>) as Record<string, unknown>

describe('OFF BY DEFAULT: a stated band is recorded, switched off with the reason, and not sent', () => {
  it('with no options at all', () => {
    const spec = deriveFilterSpec(WITH_BAND, criterion(), geo(), seniorityFixture(2))
    // Read and stored: nothing about the document is lost.
    expect(spec.company_revenue_min).toBe(1_000_000)
    expect(spec.company_revenue_max).toBe(20_000_000)
    // Switched off, and says why.
    expect(spec.omitted_axes).toContain('company_revenue')
    expect(spec.omission_reasons?.company_revenue).toMatch(/^Not opted in\./)
    // And the provider never sees it.
    expect(sent(spec)).not.toHaveProperty('revenue_range')
  })

  it('an explicit "off" is the same spec as saying nothing', () => {
    const silent = deriveFilterSpec(WITH_BAND, criterion(), geo(), seniorityFixture(2))
    const off = deriveFilterSpec(WITH_BAND, criterion(), geo(), seniorityFixture(2), { revenueFilterEnabled: false })
    expect(off).toEqual(silent)
  })

  it('nothing is switched off when the document states no band, because there is nothing to send', () => {
    const spec = deriveFilterSpec(NO_BAND, criterion(), geo(), seniorityFixture(2))
    expect(spec.company_revenue_min).toBeNull()
    expect(spec.omitted_axes).not.toContain('company_revenue')
    expect(spec.omission_reasons?.company_revenue).toBeUndefined()
    expect(sent(spec)).not.toHaveProperty('revenue_range')
  })
})

describe('OPTED IN: the band is sent', () => {
  it('sends the band the document states, and records no switch-off', () => {
    const spec = deriveFilterSpec(WITH_BAND, criterion(), geo(), seniorityFixture(2), { revenueFilterEnabled: true })
    expect(spec.omitted_axes).not.toContain('company_revenue')
    expect(spec.omission_reasons?.company_revenue).toBeUndefined()
    expect(sent(spec).revenue_range).toEqual({ min: 1_000_000, max: 20_000_000 })
  })

  it('the operator\'s switch wins over the derivation, and the objection is kept in the notes', () => {
    const spec = deriveFilterSpec(
      WITH_BAND, criterion(), geo(),
      derivationSwitchedOff({ company_revenue: 'placeholder-derivation-reason' }),
      { revenueFilterEnabled: true },
    )
    expect(spec.omitted_axes).not.toContain('company_revenue')
    expect(sent(spec).revenue_range).toEqual({ min: 1_000_000, max: 20_000_000 })
    // A reason cannot outlive its switch.
    expect(spec.omission_reasons?.company_revenue).toBeUndefined()
    // The derivation's objection is said out loud, where an operator reads it.
    expect(spec.notes).toContain('although the derivation proposed switching it off: placeholder-derivation-reason')
  })
})

describe('the reasons are carried, and only for switches that are actually off', () => {
  it('not opted in, and the derivation also said off: both reasons are recorded', () => {
    const spec = deriveFilterSpec(
      WITH_BAND, criterion(), geo(),
      derivationSwitchedOff({ company_revenue: 'placeholder-derivation-reason' }),
    )
    const reason = spec.omission_reasons?.company_revenue ?? ''
    expect(reason.startsWith(REVENUE_NOT_OPTED_IN)).toBe(true)
    expect(reason).toContain('The derivation also proposed switching it off: placeholder-derivation-reason')
  })

  it('the derivation\'s reason for another axis reaches the spec', () => {
    const spec = deriveFilterSpec(
      WITH_BAND, criterion(), geo(),
      derivationSwitchedOff({ keywords: 'placeholder-keyword-reason' }),
      { revenueFilterEnabled: true },
    )
    expect(spec.omitted_axes).toEqual(['keywords'])
    expect(spec.omission_reasons).toEqual({ keywords: 'placeholder-keyword-reason' })
    expect(sent(spec)).not.toHaveProperty('q_organization_keyword_tags')
  })

  it('a reason for an axis that is not switched off is not stored', () => {
    const spec = deriveFilterSpec(
      WITH_BAND, criterion(), geo(),
      { ...seniorityFixture(2), omitted: [], omittedReasons: { keywords: 'placeholder-orphan-reason' } },
      { revenueFilterEnabled: true },
    )
    expect(spec.omission_reasons).toEqual({})
  })
})
