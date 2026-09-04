import { describe, it, expect } from 'vitest'
import { deriveFilterSpec } from '@/lib/agents/icp-filter-spec'
import type { IcpDocument } from '@/lib/agents/icp-filter-spec'

// deriveFilterSpec used to resolve an unparseable headcount with `?? 1` and `?? 20`. Those
// fallbacks were indistinguishable downstream from a parsed range, and 20 is a hard ceiling:
// resolveHeadcountCeiling removes every prospect above company_headcount_max. So an ICP
// document that said nothing usable about size silently decided who a client could reach.
const docWith = (t1: string, t2: string): IcpDocument => ({
  summary: 'test',
  jtbd_statement: 'test',
  tier_1: {
    company_profile: { stage: 's', headcount: t1, industries: ['Management Consulting'], revenue_range: 'r' },
    buyer_profile: { title: 't', seniority: 's' },
    disqualifiers: [],
  },
  tier_2: {
    company_profile: { stage: 's', headcount: t2, industries: ['Management Consulting'], revenue_range: 'r' },
    buyer_profile: { title: 't', seniority: 's' },
    disqualifiers: [],
  },
  tier_3: {
    company_profile: { stage: 's', headcount: '1 person', industries: ['Management Consulting'], revenue_range: 'r' },
  },
})

describe('an unusable headcount stops the run instead of defaulting', () => {
  it('throws when neither tier bounds the range at all', () => {
    expect(() => deriveFilterSpec(docWith('Varies', 'Unknown'))).toThrow(/headcount bound/i)
  })

  it('throws when no tier supplies an upper bound', () => {
    // Both tiers are open-ended upward. There is no ceiling to filter on, and 20 is not one.
    expect(() => deriveFilterSpec(docWith('Over 500 employees', 'At least 100 staff')))
      .toThrow(/upper headcount bound/i)
  })

  it('names both raw strings so the operator can see what to fix', () => {
    expect(() => deriveFilterSpec(docWith('Varies', 'Unknown'))).toThrow(/Varies[\s\S]*Unknown/)
  })

  it('still resolves when only one tier bounds a side', () => {
    // A bare lower bound in one tier is not a failure if the other tier supplies a ceiling.
    const spec = deriveFilterSpec(docWith('Over 500 employees', '50-120 staff'))
    expect(spec.company_headcount_min).toBe(50)
    expect(spec.company_headcount_max).toBe(120)
  })
})
