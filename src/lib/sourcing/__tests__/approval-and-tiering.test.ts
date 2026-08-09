import { describe, it, expect, vi, beforeEach } from 'vitest'
import { approveProspects } from '@/lib/sourcing/approval'
import { classifyTier } from '@/lib/sourcing/tier-classification'
import type { ICPFilterSpec } from '@/lib/agents/icp-filter-spec'
import type { EnrichedProspect } from '@/lib/sourcing/tier-classification'

describe('Approval Function', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should move prospects from pending_review to approved and set qualified_at', async () => {
    const mockSelect = vi.fn().mockResolvedValue({
      data: [{ id: 'p1' }, { id: 'p2' }],
      error: null,
    })

    const mockEq = vi.fn().mockReturnValue({
      in: vi.fn().mockReturnValue({
        select: mockSelect,
      }),
    })

    const mockUpdate = vi.fn().mockReturnValue({
      eq: mockEq,
    })

    const mockFrom = vi.fn().mockReturnValue({
      update: mockUpdate,
    })

    const mockSupabase = { from: mockFrom } as any

    const result = await approveProspects(mockSupabase, 'org-1', ['p1', 'p2'])

    expect(result.approved_count).toBe(2)
    expect(mockUpdate).toHaveBeenCalledWith({
      sourcing_review_status: 'approved',
      qualified_at: expect.any(String),
    })
  })

  it('should be operator-gated (verified by route, not function)', () => {
    expect(approveProspects).toBeDefined()
  })

  it('should handle empty prospect list gracefully', async () => {
    const mockSupabase = { from: vi.fn() } as any
    const result = await approveProspects(mockSupabase, 'org-1', [])
    expect(result.approved_count).toBe(0)
  })

  it('should handle update errors', async () => {
    const mockSelect = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'Update failed' },
    })

    const mockEq = vi.fn().mockReturnValue({
      in: vi.fn().mockReturnValue({
        select: mockSelect,
      }),
    })

    const mockUpdate = vi.fn().mockReturnValue({
      eq: mockEq,
    })

    const mockFrom = vi.fn().mockReturnValue({
      update: mockUpdate,
    })

    const mockSupabase = { from: mockFrom } as any

    await expect(approveProspects(mockSupabase, 'org-1', ['p1'])).rejects.toThrow()
  })
})

describe('Tier Classification', () => {
  const baseSpec: ICPFilterSpec = {
    job_titles: ['Sales Director', 'VP Sales'],
    job_titles_excluded: ['Assistant'],
    seniority_levels: ['vp', 'c_suite'],
    person_countries: ['US'],
    company_countries: ['US'],
    company_headcount_min: 10,
    company_headcount_max: 500,
    industries: ['Management Consulting' as any],
    industries_excluded: [],
    keywords: [],
    keywords_excluded: [],
    notes: 'Test ICP spec',
  }

  it('should classify a verified decision-maker in-range in-industry as Tier 1', () => {
    const prospect: EnrichedProspect = {
      id: 'p1',
      organisation_id: 'org-1',
      email_status: 'verified',
      enrichment_status: 'enriched',
      job_title: 'VP of Sales',
      company_headcount: 250,
      company_industry: 'Management Consulting',
    }

    const result = classifyTier(prospect, baseSpec, null, null)
    expect(result.sourced_tier).toBe('tier_1')
    expect(result.classification_reason).toBe('tier_1_strict_match')
  })

  it('should classify a verified decision-maker with loosened headcount as Tier 2', () => {
    const prospect: EnrichedProspect = {
      id: 'p2',
      organisation_id: 'org-1',
      email_status: 'verified',
      enrichment_status: 'enriched',
      job_title: 'VP of Marketing',
      company_headcount: 600, // 50% above max of 500
      company_industry: 'Management Consulting',
    }

    const result = classifyTier(prospect, baseSpec, null, null)
    expect(result.sourced_tier).toBe('tier_2')
  })

  it('should classify a verified decision-maker with badly out-of-range headcount but matching industry as Tier 2', () => {
    const prospect: EnrichedProspect = {
      id: 'p3',
      organisation_id: 'org-1',
      email_status: 'verified',
      enrichment_status: 'enriched',
      job_title: 'Founder',
      company_headcount: 2000, // Well above widened range, but industry matches
      company_industry: 'Management Consulting',
    }

    const result = classifyTier(prospect, baseSpec, 'amber', null)
    // Tier 2 because industry matches (at least one dimension loosened)
    expect(result.sourced_tier).toBe('tier_2')
  })

  it('should return null for Tier 3 prospect when TAM is red without override', () => {
    const prospect: EnrichedProspect = {
      id: 'p4',
      organisation_id: 'org-1',
      email_status: 'verified',
      enrichment_status: 'enriched',
      job_title: 'Founder',
      company_headcount: 2000, // Out of widened range
      company_industry: 'Healthcare Services', // Not in ICP industries
    }

    const result = classifyTier(prospect, baseSpec, 'red', null)
    expect(result.sourced_tier).toBeNull()
  })

  it('should classify a verified decision-maker with mismatched industry and out-of-range headcount as Tier 3 when TAM is amber', () => {
    const prospect: EnrichedProspect = {
      id: 'p4b',
      organisation_id: 'org-1',
      email_status: 'verified',
      enrichment_status: 'enriched',
      job_title: 'Founder',
      company_headcount: 2000,
      company_industry: 'Healthcare Services',
    }

    const result = classifyTier(prospect, baseSpec, 'amber', null)
    expect(result.sourced_tier).toBe('tier_3')
  })

  it('should return null for unverified email', () => {
    const prospect: EnrichedProspect = {
      id: 'p5',
      organisation_id: 'org-1',
      email_status: 'unverified',
      enrichment_status: 'enriched',
      job_title: 'VP Sales',
      company_headcount: 100,
      company_industry: 'Management Consulting',
    }

    const result = classifyTier(prospect, baseSpec, null, null)
    expect(result.sourced_tier).toBeNull()
    expect(result.classification_reason).toContain('non_verified_email')
  })

  it('should return null for held_unverified email status', () => {
    const prospect: EnrichedProspect = {
      id: 'p6',
      organisation_id: 'org-1',
      email_status: 'held_unverified',
      enrichment_status: 'held_unverified',
      job_title: 'VP Sales',
      company_headcount: 100,
      company_industry: 'Management Consulting',
    }

    const result = classifyTier(prospect, baseSpec, null, null)
    expect(result.sourced_tier).toBeNull()
  })

  it('should discard a verified prospect with non-decision-maker seniority', () => {
    const prospect: EnrichedProspect = {
      id: 'p7',
      organisation_id: 'org-1',
      email_status: 'verified',
      enrichment_status: 'enriched',
      job_title: 'Sales Executive (entry-level)',
      company_headcount: 250,
      company_industry: 'Management Consulting',
    }

    const result = classifyTier(prospect, baseSpec, null, null)
    expect(result.sourced_tier).toBeNull()
    expect(result.classification_reason).toContain('non_decision_maker')
  })

  it('should discard a verified prospect with null job_title', () => {
    const prospect: EnrichedProspect = {
      id: 'p8',
      organisation_id: 'org-1',
      email_status: 'verified',
      enrichment_status: 'enriched',
      job_title: null, // Apollo did not return title
      company_headcount: 250,
      company_industry: 'Management Consulting',
    }

    const result = classifyTier(prospect, baseSpec, null, null)
    expect(result.sourced_tier).toBeNull()
    expect(result.classification_reason).toContain('missing_job_title')
  })

  it('should be deterministic (same inputs yield same output)', () => {
    const prospect: EnrichedProspect = {
      id: 'p9',
      organisation_id: 'org-1',
      email_status: 'verified',
      enrichment_status: 'enriched',
      job_title: 'C-Suite Executive',
      company_headcount: 150,
      company_industry: 'Management Consulting',
    }

    const result1 = classifyTier(prospect, baseSpec, 'amber', null)
    const result2 = classifyTier(prospect, baseSpec, 'amber', null)

    expect(result1.sourced_tier).toBe(result2.sourced_tier)
    expect(result1.classification_reason).toBe(result2.classification_reason)
  })

  it('should recognize founder seniority as decision-maker', () => {
    const prospect: EnrichedProspect = {
      id: 'p10',
      organisation_id: 'org-1',
      email_status: 'verified',
      enrichment_status: 'enriched',
      job_title: 'Founder & CEO',
      company_headcount: 50,
      company_industry: 'Management Consulting',
    }

    const result = classifyTier(prospect, baseSpec, null, null)
    expect(result.sourced_tier).toBe('tier_1')
  })

  it('should recognize owner seniority as decision-maker', () => {
    const prospect: EnrichedProspect = {
      id: 'p11',
      organisation_id: 'org-1',
      email_status: 'verified',
      enrichment_status: 'enriched',
      job_title: 'Owner',
      company_headcount: 25,
      company_industry: 'Management Consulting',
    }

    const result = classifyTier(prospect, baseSpec, null, null)
    expect(result.sourced_tier).toBe('tier_1')
  })

  it('should allow TAM override on red status', () => {
    const prospect: EnrichedProspect = {
      id: 'p12',
      organisation_id: 'org-1',
      email_status: 'verified',
      enrichment_status: 'enriched',
      job_title: 'VP Sales',
      company_headcount: 5000,
      company_industry: 'Healthcare Services', // Not in ICP industries - mismatch
    }

    const resultNoOverride = classifyTier(prospect, baseSpec, 'red', null)
    const resultWithOverride = classifyTier(prospect, baseSpec, 'red', 'Founder approved')

    expect(resultNoOverride.sourced_tier).toBeNull()
    expect(resultWithOverride.sourced_tier).toBe('tier_3')
  })

  it('should handle null company_headcount gracefully', () => {
    const prospect: EnrichedProspect = {
      id: 'p13',
      organisation_id: 'org-1',
      email_status: 'verified',
      enrichment_status: 'enriched',
      job_title: 'VP Sales',
      company_headcount: null, // Apollo did not return headcount
      company_industry: 'Management Consulting',
    }

    const result = classifyTier(prospect, baseSpec, null, null)
    // Should not crash, should evaluate other dimensions
    // Industry matches ICP, so Tier 2 (industry adjacent satisfied)
    expect(result.sourced_tier).toBe('tier_2')
  })

  it('should handle null company_industry gracefully', () => {
    const prospect: EnrichedProspect = {
      id: 'p14',
      organisation_id: 'org-1',
      email_status: 'verified',
      enrichment_status: 'enriched',
      job_title: 'VP Sales',
      company_headcount: 250,
      company_industry: null, // Apollo did not return industry
    }

    const result = classifyTier(prospect, baseSpec, null, null)
    // Headcount is in strict range (within widened range), industry is null
    // Tier 2 because headcount within widened range satisfies at least one dimension
    expect(result.sourced_tier).toBe('tier_2')
  })
})
