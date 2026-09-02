// Tests for tiering-trigger's step 6.5 returned-industry assertion, and for the
// removal-reason reporting in logClassificationStats.
//
// The fake honours eq(), is() and limit() by actually filtering and slicing, and
// throws on anything it does not implement. limit() in particular is honoured
// rather than swallowed: a fake that returns everything regardless makes the batch
// cap untestable and would keep the suite green with the cap deleted.
// See CLAUDE.md, "A fake that does not honour a filter cannot test that filter".

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { tierEnrichedBatch } from '@/lib/sourcing/tiering-trigger'
import {
  logClassificationStats,
  REMOVAL_REASONS,
  classifyTier,
  type EnrichedProspect,
} from '@/lib/sourcing/tier-classification'
import { clearIndustryMappingCache } from '@/lib/sourcing/industry-mapping'
import { logger } from '@/lib/logger'
import type { ICPFilterSpec } from '@/lib/agents/icp-filter-spec'

const ORG = '11111111-2222-3333-4444-555555555555'

function spec(industries: string[]): ICPFilterSpec {
  return {
    job_titles: [],
    job_titles_excluded: [],
    seniority_levels: [],
    person_countries: [],
    company_countries: [],
    company_headcount_min: 0,
    company_headcount_max: 0,
    industries: industries as ICPFilterSpec['industries'],
    industries_excluded: [],
    keywords: [],
    keywords_excluded: [],
    notes: '',
    // Rule Zero: the fragments here are abstract tokens, not job titles. This test is
    // about disqualifier plumbing, and a real title in a fixture is one copy-paste away
    // from a real title in the derivation prompt.
    buyer_criterion: {
      status: 'derived',
      accept: [{ fragment: 'qualifying-role', rank: 'primary' }],
      reject: [],
      statement: 'Test fixture.',
      evidence: [],
      unsettled_reason: null,
      sanity: null,
      derived_at: '2026-09-02T00:00:00.000Z',
      model: 'test',
    },
  }
}

interface ProspectRow {
  id: string
  organisation_id: string
  email_status: string | null
  enrichment_status: string | null
  job_title: string | null
  company_headcount: number | null
  company_industry: string | null
  company_name: string | null
  sourced_tier: string | null
  tiering_reason: string | null
}

function prospect(over: Partial<ProspectRow>): ProspectRow {
  return {
    id: 'p1',
    organisation_id: ORG,
    email_status: 'verified',
    enrichment_status: 'enriched',
    job_title: 'qualifying-role',
    company_headcount: 10,
    company_industry: 'management consulting',
    company_name: 'Acme Consulting',
    sourced_tier: null,
    // EXPLICIT. tierEnrichedBatch filters on `.is('tiering_reason', null)` to skip
    // prospects it has already classified, and the fake compares with ===, so an
    // absent field is `undefined` and would filter every fixture row out. Omitting
    // this made all four assertion tests pass zero prospects and assert nothing.
    tiering_reason: null,
    ...over,
  }
}

function makeSupabase(
  specIndustries: string[],
  prospects: ProspectRow[],
): { client: SupabaseClient; updates: Record<string, unknown>[] } {
  const updates: Record<string, unknown>[] = []

  const tables: Record<string, Record<string, unknown>[]> = {
    strategy_documents: [
      {
        id: 'doc-1',
        organisation_id: ORG,
        document_type: 'icp',
        status: 'active',
        client_approval_status: 'approved',
        icp_filter_spec: spec(specIndustries),
      },
    ],
    organisations: [{ id: ORG, client_review_enabled: true }],
    prospects: prospects as unknown as Record<string, unknown>[],
    industry_tag_mappings: [],
    agent_runs: [],
  }

  function unimplemented(method: string) {
    return () => {
      throw new Error(`fake supabase does not implement ${method}()`)
    }
  }

  const client = {
    from(table: string) {
      const filters: [string, unknown][] = []
      let limitN: number | null = null
      let pendingUpdate: Record<string, unknown> | null = null

      function matching() {
        const rows = (tables[table] ?? []).filter(row =>
          filters.every(([column, value]) => row[column] === value),
        )
        return limitN === null ? rows : rows.slice(0, limitN)
      }

      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          filters.push([column, value])
          return chain
        },
        is: (column: string, value: unknown) => {
          filters.push([column, value])
          return chain
        },
        limit: (n: number) => {
          limitN = n
          return chain
        },
        update: (payload: Record<string, unknown>) => {
          pendingUpdate = payload
          return chain
        },
        insert: (row: Record<string, unknown>) => {
          tables[table] = [...(tables[table] ?? []), row]
          const inserted: Record<string, unknown> = {
            select: () => inserted,
            single: async () => ({ data: { id: 'run-1' }, error: null }),
            then: (resolve: (v: unknown) => unknown) =>
              Promise.resolve({ data: null, error: null }).then(resolve),
          }
          return inserted
        },
        single: async () => {
          const rows = matching()
          if (rows.length !== 1) {
            return { data: null, error: { message: `no single row for ${table}` } }
          }
          return { data: rows[0], error: null }
        },
        then: (resolve: (v: unknown) => unknown) => {
          if (pendingUpdate) {
            updates.push({ table, filters: [...filters], payload: pendingUpdate })
            return Promise.resolve({ data: null, error: null }).then(resolve)
          }
          return Promise.resolve({ data: matching(), error: null }).then(resolve)
        },
        not: unimplemented('not'),
        in: unimplemented('in'),
        or: unimplemented('or'),
        order: unimplemented('order'),
        delete: unimplemented('delete'),
        maybeSingle: unimplemented('maybeSingle'),
      }

      return chain
    },
  } as unknown as SupabaseClient

  return { client, updates }
}

beforeEach(() => {
  // Module-level cache with a 60s TTL. Without this, one test's mappings leak
  // into the next and the assertion under test reads stale data.
  clearIndustryMappingCache()
  vi.restoreAllMocks()
})

describe('tiering-trigger: returned-industry assertion', () => {
  it('fails the run when no returned prospect matches a spec industry', async () => {
    const { client } = makeSupabase(
      ['Primary and Secondary Education'],
      [
        prospect({ id: 'p1', company_industry: 'restaurants', company_name: 'Bistro Ltd' }),
        prospect({ id: 'p2', company_industry: 'automotive', company_name: 'Cars Ltd' }),
      ],
    )

    const result = await tierEnrichedBatch(client, ORG, 100)

    expect(result.error).toBeDefined()
    expect(result.error).toContain('not one of the 2 enriched prospects')
    // Names what was asked for and what actually came back.
    expect(result.error).toContain('Primary and Secondary Education')
    expect(result.error).toContain('restaurants')
    expect(result.error).toContain('automotive')
  })

  it('passes when at least one returned prospect matches', async () => {
    const { client } = makeSupabase(
      ['Management Consulting'],
      [
        prospect({ id: 'p1', company_industry: 'management consulting' }),
        prospect({ id: 'p2', company_industry: 'restaurants', company_name: 'Bistro Ltd' }),
      ],
    )

    const result = await tierEnrichedBatch(client, ORG, 100)

    expect(result.error).toBeUndefined()
    expect(result.prospects_classified).toBe(2)
  })

  it('does not fire when the spec names no industries', async () => {
    const { client } = makeSupabase(
      [],
      [prospect({ id: 'p1', company_industry: 'restaurants', company_name: 'Bistro Ltd' })],
    )

    const result = await tierEnrichedBatch(client, ORG, 100)

    expect(result.error).toBeUndefined()
  })

  it('counts a row with no industry at all as off-specification, not as a match', async () => {
    const { client } = makeSupabase(
      ['Management Consulting'],
      [prospect({ id: 'p1', company_industry: null, company_name: 'Nameless Ltd' })],
    )

    const result = await tierEnrichedBatch(client, ORG, 100)

    expect(result.error).toBeDefined()
    expect(result.error).toContain('(no industry)')
  })

  it('honours the batch cap, so the assertion reads the batch it was given', async () => {
    // Guards the fake as much as the code: if limit() were swallowed this would
    // classify 3 rather than 1 and the assertion below would read a different set.
    const { client } = makeSupabase(
      ['Management Consulting'],
      [
        prospect({ id: 'p1', company_industry: 'management consulting' }),
        prospect({ id: 'p2', company_industry: 'management consulting' }),
        prospect({ id: 'p3', company_industry: 'management consulting' }),
      ],
    )

    const result = await tierEnrichedBatch(client, ORG, 1)

    expect(result.prospects_classified).toBe(1)
  })
})

describe('logClassificationStats: removal reporting', () => {
  it('emits a flat, always-present key for every registered removal reason', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {})

    logClassificationStats(
      [
        { prospect_id: 'a', sourced_tier: null, fit_score: null, tiering_reason: 'not_decision_maker' },
        { prospect_id: 'b', sourced_tier: null, fit_score: null, tiering_reason: 'not_decision_maker' },
        { prospect_id: 'c', sourced_tier: null, fit_score: null, tiering_reason: 'industry_not_consulting' },
        { prospect_id: 'd', sourced_tier: 'tier_1', fit_score: 90, tiering_reason: 'tier_1 (score 90)' },
      ],
      ORG,
    )

    expect(info).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)

    const payload = warn.mock.calls[0][1] as Record<string, unknown>

    expect(payload.removed_not_decision_maker).toBe(2)
    expect(payload.removed_industry_not_consulting).toBe(1)
    expect(payload.removed_count).toBe(3)
    expect(payload.tier_1_count).toBe(1)

    // Every registered reason present, including the zeroes. A key that appears
    // only when non-zero makes "none removed for this reason" and "this reason is
    // no longer counted" indistinguishable downstream.
    for (const reason of REMOVAL_REASONS) {
      expect(payload).toHaveProperty(`removed_${reason}`)
      expect(typeof payload[`removed_${reason}`]).toBe('number')
    }
  })

  it('logs at info, not warn, when nothing was removed', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {})

    logClassificationStats(
      [{ prospect_id: 'a', sourced_tier: 'tier_1', fit_score: 90, tiering_reason: 'tier_1 (score 90)' }],
      ORG,
    )

    expect(warn).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledTimes(1)
  })

  it('counts and names an unregistered removal reason instead of dropping it', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    logClassificationStats(
      [{ prospect_id: 'a', sourced_tier: null, fit_score: null, tiering_reason: 'invented_reason' }],
      ORG,
    )

    const payload = warn.mock.calls[0][1] as Record<string, unknown>
    expect(payload.removed_other).toBe(1)
    expect(payload.removed_other_reasons).toEqual(['invented_reason'])
  })
})

describe('classifyTier: every disqualifier returns a registered reason', () => {
  // Behavioural rather than a source scan: each case actually drives classifyTier
  // down one disqualifier path and reads the reason it returned. A new disqualifier
  // whose reason is not registered shows up as removed_other in the log above.
  const cases: Array<[string, EnrichedProspect]> = [
    ['email_unverified', { id: 'x', organisation_id: ORG, email_status: 'unknown', enrichment_status: 'enriched', job_title: 'qualifying-role', company_headcount: 10, company_industry: 'management consulting', company_name: 'A Consulting' }],
    ['no_title', { id: 'x', organisation_id: ORG, email_status: 'verified', enrichment_status: 'enriched', job_title: null, company_headcount: 10, company_industry: 'management consulting', company_name: 'A Consulting' }],
    ['not_decision_maker', { id: 'x', organisation_id: ORG, email_status: 'verified', enrichment_status: 'enriched', job_title: 'other-role', company_headcount: 10, company_industry: 'management consulting', company_name: 'A Consulting' }],
    ['company_too_large', { id: 'x', organisation_id: ORG, email_status: 'verified', enrichment_status: 'enriched', job_title: 'qualifying-role', company_headcount: 500, company_industry: 'management consulting', company_name: 'A Consulting' }],
    ['industry_not_consulting', { id: 'x', organisation_id: ORG, email_status: 'verified', enrichment_status: 'enriched', job_title: 'qualifying-role', company_headcount: 10, company_industry: 'restaurants', company_name: 'Bistro Ltd' }],
  ]

  it.each(cases)('%s is a registered removal reason', async (expected, input) => {
    const result = await classifyTier(input, spec(['Management Consulting']))
    expect(result.tiering_reason).toBe(expected)
    expect(REMOVAL_REASONS as readonly string[]).toContain(result.tiering_reason)
  })

  it('industry_excluded is a registered removal reason', async () => {
    const excluded = spec(['Management Consulting'])
    excluded.industries_excluded = ['Marketing Consulting'] as ICPFilterSpec['industries_excluded']

    const result = await classifyTier(
      {
        id: 'x',
        organisation_id: ORG,
        email_status: 'verified',
        enrichment_status: 'enriched',
        job_title: 'qualifying-role',
        company_headcount: 10,
        company_industry: 'marketing & advertising',
        company_name: 'Ad Shop',
      },
      excluded,
    )

    expect(result.tiering_reason).toBe('industry_excluded')
    expect(REMOVAL_REASONS as readonly string[]).toContain(result.tiering_reason)
  })
})
