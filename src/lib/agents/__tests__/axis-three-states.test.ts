// AN AXIS HAS THREE STATES, AND TWO OF THEM USED TO BE THE SAME VALUE.
//
//   PRESENT              values were derived. The handler sends them.
//   DELIBERATELY OMITTED the derivation decided this axis should not constrain. The handler
//                        sends nothing and the spec records the decision.
//   FAILED TO DERIVE     nothing could be established. The spec is refused.
//
// Before this, an empty array meant only the third, and refusing was right for it and wrong
// for the second. MEASURED across all three live clients: sending every seniority band the
// provider accepts returns exactly the population of not sending the parameter at all. That
// axis has never added a person to any search, so "omit it" is a legitimate proposal and it
// must not read as a failure.
//
// NO BAND OR AXIS VALUE IS WRITTEN HERE. Every value comes from the fixture or from the
// exported list, by position.

import { describe, it, expect } from 'vitest'
import { deriveFilterSpec, CANONICAL_INDUSTRIES, OMITTABLE_AXES } from '@/lib/agents/icp-filter-spec'
import type { IcpDocument, SpecSeniority } from '@/lib/agents/icp-filter-spec'
import { buildApolloRequest } from '@/lib/sourcing/handlers/adapter-apollo'
import { aTargetableCode, aGeography } from '@/test-utils/geography-fixture'
import { seniorityFixture, someBands, NO_SENIORITY } from '@/test-utils/seniority-fixture'

const anIndustry = () => CANONICAL_INDUSTRIES[0]
const SENIORITY_AXIS = OMITTABLE_AXES[0]   // by position, never by name

const doc: IcpDocument = {
  summary: 's',
  jtbd_statement: 'j',
  tier_1: {
    company_profile: { revenue_range: 'GBP 1M to 20M', headcount: '5-20 people', industries: [anIndustry()] },
    buyer_profile: { title: 't', seniority: 'as the document states it' },
    disqualifiers: [],
  },
  tier_2: {
    company_profile: { revenue_range: 'GBP 1M to 20M', headcount: '5-20 people', industries: [anIndustry()] },
    buyer_profile: { title: 't', seniority: 'as the document states it' },
    disqualifiers: [],
  },
  tier_3: { company_profile: { revenue_range: 'r', headcount: '5-20 people', industries: [] } },
}
const geo = () => aGeography([aTargetableCode()])

// A criterion with one contentless fragment. The handler refuses a spec with no job titles,
// which is correct and unrelated to what this file tests, so a fragment is supplied. It is a
// placeholder, not a role: no real title may appear in a fixture.
const aCriterion = () => ({
  status: 'derived' as const,
  accept: [{ fragment: 'a-role-fragment', rank: 'primary' as const }],
  reject: [], statement: 's', evidence: [], unsettled_reason: null, sanity: null,
  derived_at: new Date(0).toISOString(), model: 'test',
})

const omitted = (): SpecSeniority => ({ bands: [], discarded: [], evidence: '', omitted: [SENIORITY_AXIS] })

// The seniority tests below are about SENIORITY. The fixture states a revenue band, and since
// 2026-09-10 a band is switched off for a client not opted in, which would add a second axis
// to every omitted_axes they assert exactly. Opting in keeps each assertion exact; revenue's
// own states are tested at the bottom of this file and in revenue-opt-in.test.ts.
const OPTED_IN = { revenueFilterEnabled: true }

describe('the three states behave differently and read differently', () => {
  it('PRESENT: values are stored and the handler sends them', () => {
    const spec = deriveFilterSpec(doc, aCriterion(), geo(), seniorityFixture(3), OPTED_IN)
    expect(spec.seniority_levels).toEqual(someBands(3))
    expect(spec.omitted_axes).toEqual([])

    const request = buildApolloRequest(spec as unknown as Record<string, unknown>) as Record<string, unknown>
    expect(request.person_seniorities).toEqual(someBands(3))
  })

  it('DELIBERATELY OMITTED: the spec is built, the decision is recorded, the handler sends nothing', () => {
    const spec = deriveFilterSpec(doc, aCriterion(), geo(), omitted(), OPTED_IN)

    // It did NOT refuse. That is the whole change.
    expect(spec.seniority_levels).toEqual([])
    expect(spec.omitted_axes).toEqual([SENIORITY_AXIS])

    const request = buildApolloRequest(spec as unknown as Record<string, unknown>) as Record<string, unknown>
    // Absent, which is the provider's own "no constraint", rather than an empty array which
    // some providers read as "match nothing".
    expect(request.person_seniorities).toBeUndefined()
    expect('person_seniorities' in request).toBe(false)
  })

  it('FAILED TO DERIVE: refuses, and says what could not be derived', () => {
    expect(() => deriveFilterSpec(doc, aCriterion(), geo(), NO_SENIORITY)).toThrow(/no seniority bands/i)
  })

  it('the three outcomes are genuinely different, not two spellings of one', () => {
    const present = deriveFilterSpec(doc, aCriterion(), geo(), seniorityFixture(2))
    const chose = deriveFilterSpec(doc, aCriterion(), geo(), omitted())
    let failed = ''
    try { deriveFilterSpec(doc, aCriterion(), geo(), NO_SENIORITY) } catch (e) { failed = (e as Error).message }

    expect(present.seniority_levels.length).toBeGreaterThan(0)
    expect(chose.seniority_levels.length).toBe(0)
    expect(failed).not.toBe('')

    // Present and omitted differ in the RECORD, not only in the array, which is what lets a
    // reader tell "we chose not to" from "there was nothing".
    expect(present.omitted_axes).not.toEqual(chose.omitted_axes)
  })

  it('omitting one axis does not excuse an unrelated failure', () => {
    // The dangerous shape: an omission list that switches off every refusal. Geography is
    // not omittable and must still refuse.
    expect(() => deriveFilterSpec(doc, null, null as never, omitted())).toThrow(/geography/i)
  })

  it('only listed axes may be omitted, and geography is not one of them', () => {
    // Omitting geography would mean sourcing everywhere, including the countries the legal
    // subtraction removes. It must not be expressible.
    expect([...OMITTABLE_AXES]).not.toContain('person_countries')
    expect([...OMITTABLE_AXES]).not.toContain('company_countries')
    expect(OMITTABLE_AXES.length).toBeGreaterThan(0)
  })
})

describe('the revenue band the document always stated and nothing ever read', () => {
  it('is parsed onto the spec, and sent only for a client who has been opted in', () => {
    // Opt-in per client since 2026-09-10: the provider's filter drops every company with no
    // revenue figure recorded. The band is ALWAYS read and stored; the opt-in decides only
    // whether it is sent.
    const off = deriveFilterSpec(doc, aCriterion(), geo(), seniorityFixture(2))
    expect(off.company_revenue_min).toBe(1_000_000)
    expect(off.company_revenue_max).toBe(20_000_000)
    expect(buildApolloRequest(off as unknown as Record<string, unknown>)).not.toHaveProperty('revenue_range')

    const on = deriveFilterSpec(doc, aCriterion(), geo(), seniorityFixture(2), OPTED_IN)
    const request = buildApolloRequest(on as unknown as Record<string, unknown>) as Record<string, unknown>
    expect(request.revenue_range).toEqual({ min: 1_000_000, max: 20_000_000 })
  })

  it('is omitted, not defaulted, when the document states none', () => {
    const silent: IcpDocument = {
      ...doc,
      tier_1: { ...doc.tier_1, company_profile: { ...doc.tier_1.company_profile, revenue_range: 'not stated' } },
      tier_2: { ...doc.tier_2, company_profile: { ...doc.tier_2.company_profile, revenue_range: 'not stated' } },
    }
    const spec = deriveFilterSpec(silent, aCriterion(), geo(), seniorityFixture(2))
    expect(spec.company_revenue_min).toBeNull()

    const request = buildApolloRequest(spec as unknown as Record<string, unknown>) as Record<string, unknown>
    // A floor of zero would be a constraint the client never asked for.
    expect(request.revenue_range).toBeUndefined()
  })
})
