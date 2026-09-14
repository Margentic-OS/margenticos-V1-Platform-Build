// A PLAINLY HELD SECOND JOB IS DECIDED AT TIERING, FREE, NOT INSIDE RESEARCH.
//
// The research synthesis call decided this as its primary_occupation check, which runs after
// the verification probe and after $0.13 to $0.19 of model spend per prospect. Enrichment has
// already bought the employment history, so tiering can read it for nothing.
//
// Two things need pinning, and the second is the one that would rot silently: the disqualifier
// itself, and that the tiering query still ASKS for the column it reads. Drop the column from
// the select and the blob arrives undefined, the gate never fires, and nothing else notices.
//
// RULE ZERO: no job title, market or company name below.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { classifyTier, REMOVAL_REASONS, type EnrichedProspect } from '@/lib/sourcing/tier-classification'
import { tierEnrichedBatch } from '@/lib/sourcing/tiering-trigger'
import { clearIndustryMappingCache } from '@/lib/sourcing/industry-mapping'
import { CANONICAL_INDUSTRIES } from '@/lib/agents/icp-filter-spec'
import type { ICPFilterSpec } from '@/lib/agents/icp-filter-spec'

const ORG = '11111111-2222-3333-4444-555555555555'

function spec(): ICPFilterSpec {
  return {
    job_titles: [], job_titles_excluded: [], seniority_levels: [],
    person_countries: [], company_countries: [],
    company_headcount_min: 0, company_headcount_max: 100,
    industries: [CANONICAL_INDUSTRIES[0]] as ICPFilterSpec['industries'],
    industries_excluded: [], keywords: [], keywords_excluded: [],
    company_revenue_min: null, company_revenue_max: null, notes: '',
    buyer_criterion: {
      status: 'derived', accept: [{ fragment: 'qualifying-role', rank: 'primary' }], reject: [],
      statement: 'Test fixture.', evidence: [], unsettled_reason: null, sanity: null,
      derived_at: '2026-09-02T00:00:00.000Z', model: 'test',
    },
  }
}

const history = (orgIds: Array<string | null>) => ({
  organization_id: 'own-org',
  employment_history: [
    { organization_id: 'own-org', current: true, end_date: null, start_date: '2019-01-01' },
    ...orgIds.map(id => ({ organization_id: id, current: true, end_date: null, start_date: '2021-01-01' })),
  ],
})

const prospect = (over: Partial<EnrichedProspect> = {}): EnrichedProspect => ({
  id: 'p-1', organisation_id: ORG, email_status: 'verified', enrichment_status: 'enriched',
  job_title: 'a qualifying-role of some kind', company_headcount: 10,
  company_industry: CANONICAL_INDUSTRIES[0], company_name: 'Placeholder Company', ...over,
})

describe('the disqualifier', () => {
  it('removes a prospect the provider says holds another current job', async () => {
    const result = await classifyTier(prospect({ apollo_enrichment_data: history(['other-org']) }), spec())
    expect(result.tiering_reason).toBe('holds_another_current_role')
    expect(result.sourced_tier).toBeNull()
  })

  // A prospect that SURVIVES tiering still carries a tiering_reason: it holds the score line
  // ("tier_1 (score 100): ..."). Removal is the pair of sourced_tier null AND a reason from
  // REMOVAL_REASONS, which is what these assert.
  const removed = (r: { sourced_tier: string | null; tiering_reason: string | null }) =>
    r.sourced_tier === null && (REMOVAL_REASONS as readonly string[]).includes(r.tiering_reason ?? '')

  it('keeps a prospect whose only current position is their own', async () => {
    const result = await classifyTier(prospect({ apollo_enrichment_data: history([]) }), spec())
    expect(removed(result)).toBe(false)
    expect(result.sourced_tier).not.toBeNull()
  })

  it('keeps a prospect whose second position the provider could not attribute', async () => {
    // The ambiguous case stays with the judge, which is the whole point of counting only
    // what the provider names.
    const result = await classifyTier(prospect({ apollo_enrichment_data: history([null]) }), spec())
    expect(removed(result)).toBe(false)
  })

  it('keeps a prospect enriched before the history was stored', async () => {
    expect(removed(await classifyTier(prospect({ apollo_enrichment_data: undefined }), spec()))).toBe(false)
  })

  it('is a listed removal reason, so the counts report it', () => {
    expect(REMOVAL_REASONS).toContain('holds_another_current_role')
  })
})

describe('the tiering query still asks for the column the gate reads', () => {
  let selects: string[] = []

  function fakeSupabase(rows: Array<Record<string, unknown>>) {
    const client = {
      from(table: string) {
        const chain: Record<string, unknown> = {
          select: (cols: string) => { if (table === 'prospects') selects.push(cols); return chain },
          eq: () => chain, is: () => chain, not: () => chain, order: () => chain,
          limit: () => Promise.resolve({ data: rows, error: null }),
          single: async () => ({
            data: table === 'strategy_documents'
              ? { id: 'doc-1', icp_filter_spec: spec(), content: {} }
              : { id: ORG, client_review_enabled: false },
            error: null,
          }),
          maybeSingle: async () => ({ data: null, error: null }),
          insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'run-1' }, error: null }) }) }),
          update: () => chain,
          then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve),
        }
        return chain
      },
    }
    return client as unknown as SupabaseClient
  }

  beforeEach(() => { selects = []; clearIndustryMappingCache(); vi.restoreAllMocks() })

  it('selects apollo_enrichment_data, without which the gate silently never fires', async () => {
    const rows = [{ ...prospect(), apollo_enrichment_data: history(['other-org']) }]
    await tierEnrichedBatch(fakeSupabase(rows), ORG, 10).catch(() => undefined)
    expect(selects.some(s => s.includes('apollo_enrichment_data'))).toBe(true)
  })
})
