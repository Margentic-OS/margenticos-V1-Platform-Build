// THE APPROVAL STEP READS THE REVENUE OPT-IN FROM THE ORGANISATION, AND A FAILED READ IS "OFF".
//
// persistIcpFilterSpec builds the spec a client is sourced with. Since 2026-09-10 the revenue
// band in the ICP is sent only for a client opted in through
// organisations.sourcing_revenue_filter_enabled, read HERE, when the spec is built. These tests
// check the spec that is actually WRITTEN, and the request it would produce.
//
// The fake is a copy of the one in removed-prospects-requeue.test.ts: it honours every filter
// persist applies, and throws on any method it does not implement.
//
// RULE ZERO: no industry, sector, country or company name below.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { persistIcpFilterSpec } from '@/lib/sourcing/persist-icp-filter-spec'
import { buildApolloRequest } from '@/lib/sourcing/handlers/adapter-apollo'
import { CANONICAL_INDUSTRIES } from '@/lib/agents/icp-filter-spec'
import { clearIndustryMappingCache } from '@/lib/sourcing/industry-mapping'
import { seniorityFixture } from '@/test-utils/seniority-fixture'
import { aTargetableCode } from '@/test-utils/geography-fixture'
import { logger } from '@/lib/logger'

vi.mock('@sentry/nextjs', () => ({
  withScope: (fn: (s: unknown) => void) => fn({ setExtra() {}, setContext() {} }),
  captureMessage: () => {},
  captureException: () => {},
  flush: async () => true,
}))

vi.mock('@/agents/buyer-criterion-agent', () => ({
  deriveBuyerCriterionWithVocabulary: async () => ({
    criterion: {
      status: 'derived', accept: [{ fragment: 'a-fragment', rank: 'primary' }], reject: [],
      statement: 's', evidence: [], unsettled_reason: null, sanity: null,
      derived_at: new Date(0).toISOString(), model: 'test',
    },
    vocabulary: { sells: 's', usedFor: 'u', nameWords: [] },
    seniority: seniorityFixture(),
  }),
}))

// The fit dimension derivation is a paid model call and is never reached from this file.
vi.mock('@/agents/fit-dimensions-agent', () => ({
  deriveFitDimensions: async () => ({ dimensions: [], derived_at: new Date(0).toISOString(), model: 'test' }),
}))

vi.mock('@/lib/sourcing/resolve-icp-geography', () => ({
  resolveIcpGeography: async () => ({
    countries: [aTargetableCode()],
    removed_by_exclusion: [],
    unresolved_phrases: [],
  }),
}))

const ORG = '11111111-2222-3333-4444-555555555555'
const OTHER_ORG = '99999999-8888-7777-6666-555555555555'

interface Row { [k: string]: unknown }

function makeSupabase(tables: Record<string, Row[]>) {
  const updates: { table: string; payload: Row; matched: Row[] }[] = []
  function unimplemented(m: string) {
    return () => { throw new Error(`fake supabase does not implement ${m}()`) }
  }
  const client = {
    from(table: string) {
      const eqs: [string, unknown][] = []
      const notNulls: string[] = []
      let limitN: number | null = null
      let pending: Row | null = null
      const match = () => {
        let rows = (tables[table] ?? []).filter(r => eqs.every(([c, v]) => r[c] === v))
        rows = rows.filter(r => notNulls.every(c => r[c] !== null && r[c] !== undefined))
        return limitN === null ? rows : rows.slice(0, limitN)
      }
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (c: string, v: unknown) => { eqs.push([c, v]); return chain },
        is: (c: string, v: unknown) => { eqs.push([c, v]); return chain },
        not: (c: string, op: string, v: unknown) => {
          if (op !== 'is' || v !== null) throw new Error(`fake supports only .not(col,'is',null)`)
          notNulls.push(c)
          return chain
        },
        limit: (n: number) => { limitN = n; return chain },
        update: (p: Row) => { pending = p; return chain },
        insert: () => {
          const ins: Record<string, unknown> = {
            select: () => ins,
            single: async () => ({ data: { id: 'run-1' }, error: null }),
            then: (r: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(r),
          }
          return ins
        },
        single: async () => {
          const rows = match()
          return rows.length === 1
            ? { data: rows[0], error: null }
            : { data: null, error: { message: `no single row for ${table}` } }
        },
        then: (resolve: (v: unknown) => unknown) => {
          if (pending) {
            const matched = match()
            updates.push({ table, payload: pending, matched: [...matched] })
            for (const row of matched) Object.assign(row, pending)
            return Promise.resolve({ data: matched, error: null }).then(resolve)
          }
          return Promise.resolve({ data: match(), error: null }).then(resolve)
        },
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

// A real document shape that STATES a revenue band on both tiers.
function icpContent() {
  const tier = (headcount: string, industry: string) => ({
    company_profile: { revenue_range: 'GBP 500K to 5M', headcount, industries: [industry] },
    buyer_profile: { title: 'a role this market uses', seniority: 'as the document states it' },
    disqualifiers: [],
  })
  return {
    jtbd_statement: 'j',
    summary: 's',
    tier_1: tier('5-20 people', CANONICAL_INDUSTRIES[0]),
    tier_2: tier('21-50 people', CANONICAL_INDUSTRIES[1]),
    tier_3: { company_profile: { revenue_range: 'GBP 500K to 5M', headcount: '51-100 people', industries: [] } },
  }
}

function tables(organisations: Row[] | null): Record<string, Row[]> {
  return {
    strategy_documents: [{ id: 'doc-1', organisation_id: ORG, document_type: 'icp', content: icpContent() }],
    prospects: [],
    ...(organisations ? { organisations } : {}),
  }
}

function writtenSpec(updates: { table: string; payload: Row }[]): Record<string, unknown> {
  const specWrites = updates.filter(u => u.table === 'strategy_documents' && 'icp_filter_spec' in u.payload)
  expect(specWrites.length, 'persist must write a spec for this test to mean anything').toBeGreaterThan(0)
  return specWrites[specWrites.length - 1].payload.icp_filter_spec as Record<string, unknown>
}

beforeEach(() => {
  clearIndustryMappingCache()
  vi.restoreAllMocks()
})

describe('persistIcpFilterSpec reads the revenue opt-in from the organisation', () => {
  it('NOT opted in: the band is stored, switched off with the reason, and not sent', async () => {
    const { client, updates } = makeSupabase(tables([{ id: ORG, sourcing_revenue_filter_enabled: false }]))
    await persistIcpFilterSpec(client, 'doc-1')
    const spec = writtenSpec(updates)
    expect(spec.company_revenue_min).toBe(500_000)
    expect(spec.company_revenue_max).toBe(5_000_000)
    expect(spec.omitted_axes).toContain('company_revenue')
    expect((spec.omission_reasons as Record<string, string>).company_revenue).toMatch(/^Not opted in\./)
    expect(buildApolloRequest(spec)).not.toHaveProperty('revenue_range')
  })

  it('OPTED IN: the band is sent', async () => {
    const { client, updates } = makeSupabase(tables([{ id: ORG, sourcing_revenue_filter_enabled: true }]))
    await persistIcpFilterSpec(client, 'doc-1')
    const spec = writtenSpec(updates)
    expect(spec.omitted_axes).not.toContain('company_revenue')
    expect(buildApolloRequest(spec).revenue_range).toEqual({ min: 500_000, max: 5_000_000 })
  })

  it('reads THIS organisation only: another organisation\'s setting never decides it', async () => {
    // This organisation is opted in and another is not. A read that dropped its
    // organisation filter would match two rows, fail, fall back to off, and go red here.
    const { client, updates } = makeSupabase(tables([
      { id: ORG, sourcing_revenue_filter_enabled: true },
      { id: OTHER_ORG, sourcing_revenue_filter_enabled: false },
    ]))
    await persistIcpFilterSpec(client, 'doc-1')
    expect(buildApolloRequest(writtenSpec(updates)).revenue_range).toEqual({ min: 500_000, max: 5_000_000 })
  })

  it('a failed read is treated as NOT opted in, and says so', async () => {
    const warn = vi.spyOn(logger, 'warn')
    const { client, updates } = makeSupabase(tables(null))
    await persistIcpFilterSpec(client, 'doc-1')
    const spec = writtenSpec(updates)
    expect(spec.omitted_axes).toContain('company_revenue')
    expect(buildApolloRequest(spec)).not.toHaveProperty('revenue_range')
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/could not read the revenue opt-in/),
      expect.objectContaining({ organisation_id: ORG }),
    )
  })
})
