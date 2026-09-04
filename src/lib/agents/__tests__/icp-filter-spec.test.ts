import { describe, it, expect } from 'vitest'
import { deriveFilterSpec } from '@/lib/agents/icp-filter-spec'
import type { IcpDocument } from '@/lib/agents/icp-filter-spec'
import { aGeography } from '@/test-utils/geography-fixture'

describe('deriveFilterSpec', () => {
  describe('headcount union across tiers', () => {
    it('should take min across both tiers and max across both tiers', () => {
      const doc: IcpDocument = {
        summary: 'test',
        jtbd_statement: 'test',
        tier_1: {
          company_profile: {
            stage: 'Post-validation',
            headcount: '2-20 people',
            industries: ['Management Consulting'],
            revenue_range: '£500K-£5M',
          },
          buyer_profile: { title: 'Founder', seniority: 'Founder-led' },
          disqualifiers: [],
        },
        tier_2: {
          company_profile: {
            stage: 'Post-first-clients',
            headcount: '1-3 people',
            industries: ['Management Consulting'],
            revenue_range: '£300K-£500K',
          },
          buyer_profile: { title: 'Solo', seniority: 'Solo' },
          disqualifiers: [],
        },
        tier_3: {
          company_profile: {
            industries: ['Business Coaching'],
            stage: 'Idea',
            headcount: '1 person',
            revenue_range: 'Pre-revenue',
          },
        },
      }

      const spec = deriveFilterSpec(doc, null, aGeography())

      // Tier 1: 2-20, Tier 2: 1-3
      // Union: min(2,1) = 1, max(20,3) = 20
      expect(spec.company_headcount_min).toBe(1)
      expect(spec.company_headcount_max).toBe(20)
    })
  })

  describe('founder-led seniority inclusion', () => {
    it('should include founder and owner when buyer profile indicates founder-led', () => {
      const doc: IcpDocument = {
        summary: 'test',
        jtbd_statement: 'test',
        tier_1: {
          company_profile: {
            stage: 'Post-validation',
            headcount: '2-20 people',
            industries: ['Management Consulting'],
            revenue_range: '£500K-£5M',
          },
          buyer_profile: { title: 'Founder / Managing Director', seniority: 'Founder-led' },
          disqualifiers: [],
        },
        tier_2: {
          company_profile: {
            stage: 'Post-first-clients',
            headcount: '1-3 people',
            industries: ['Management Consulting'],
            revenue_range: '£300K-£500K',
          },
          buyer_profile: { title: 'Founder', seniority: 'Solo operator' },
          disqualifiers: [],
        },
        tier_3: {
          company_profile: {
            industries: ['Business Coaching'],
            stage: 'Idea',
            headcount: '1 person',
            revenue_range: 'Pre-revenue',
          },
        },
      }

      const spec = deriveFilterSpec(doc, null, aGeography())

      // Must include founder and owner for founder-led ICPs (Apollo filters on these distinct tags)
      expect(spec.seniority_levels).toContain('founder')
      expect(spec.seniority_levels).toContain('owner')
      expect(spec.seniority_levels).toContain('c_suite')
    })
  })

  describe('departments removal', () => {
    it('should not emit departments field in derived spec', () => {
      const doc: IcpDocument = {
        summary: 'test',
        jtbd_statement: 'test',
        tier_1: {
          company_profile: {
            stage: 'Post-validation',
            headcount: '2-20 people',
            industries: ['Management Consulting'],
            revenue_range: '£500K-£5M',
          },
          buyer_profile: { title: 'Founder', seniority: 'Founder-led' },
          disqualifiers: [],
        },
        tier_2: {
          company_profile: {
            stage: 'Post-first-clients',
            headcount: '1-3 people',
            industries: ['Management Consulting'],
            revenue_range: '£300K-£500K',
          },
          buyer_profile: { title: 'Solo', seniority: 'Solo' },
          disqualifiers: [],
        },
        tier_3: {
          company_profile: {
            industries: ['Business Coaching'],
            stage: 'Idea',
            headcount: '1 person',
            revenue_range: 'Pre-revenue',
          },
        },
      }

      const spec = deriveFilterSpec(doc, null, aGeography())

      // departments field should not exist
      expect('departments' in spec).toBe(false)
    })
  })
})
