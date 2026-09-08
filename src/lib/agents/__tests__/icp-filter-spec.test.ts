import { describe, it, expect } from 'vitest'
import { deriveFilterSpec } from '@/lib/agents/icp-filter-spec'
import type { IcpDocument } from '@/lib/agents/icp-filter-spec'
import { aGeography } from '@/test-utils/geography-fixture'
import { seniorityFixture } from '@/test-utils/seniority-fixture'

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

      const spec = deriveFilterSpec(doc, null, aGeography(), seniorityFixture())

      // Tier 1: 2-20, Tier 2: 1-3
      // Union: min(2,1) = 1, max(20,3) = 20
      expect(spec.company_headcount_min).toBe(1)
      expect(spec.company_headcount_max).toBe(20)
    })
  })

  // ─── DELETED 2026-09-08: this test pinned the defect ──────────────────────
  //
  // It asserted that a document whose buyer prose mentioned one of two particular words
  // produced a fixed list of seniority bands. That behaviour is gone, so the test could
  // only be kept by keeping the defect.
  //
  // MEASURED before deleting it, against the live provider on all three live clients: the
  // rule it pinned removed 103 of the 104 people one client's own job titles reach, 35,585
  // of 46,772 for another, and 6,403 for the third, and for all three, sending every band
  // the provider accepts returned the same count as omitting the parameter entirely.
  //
  // WHAT REPLACES IT, so this is a move rather than a loss of coverage:
  //   spec-seniority-required.test.ts asserts the refusal when nothing is derived, and
  //   asserts the OPPOSITE of what this one did: that two documents whose seniority prose
  //   differs completely produce the same spec, because nothing reads that prose any more.

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

      const spec = deriveFilterSpec(doc, null, aGeography(), seniorityFixture())

      // departments field should not exist
      expect('departments' in spec).toBe(false)
    })
  })
})
