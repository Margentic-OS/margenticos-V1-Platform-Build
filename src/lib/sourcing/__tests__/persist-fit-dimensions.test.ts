// THE APPROVAL STEP FIXES THE CLIENT'S FIT DIMENSIONS, AND A FAILED DERIVATION CHANGES NOTHING.
//
// persistIcpFilterSpec derives the dimension list once per approval and stores it on the spec,
// so the research judge reads the same list for every prospect instead of re-deciding it. These
// tests check the spec that is actually WRITTEN.
//
// The fake is a copy of the one in persist-reads-revenue-opt-in.test.ts: it honours every filter
// persist applies, and throws on any method it does not implement.
//
// RULE ZERO: no industry, sector, country or company name below.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { persistIcpFilterSpec } from '@/lib/sourcing/persist-icp-filter-spec'
import { CANONICAL_INDUSTRIES } from '@/lib/agents/icp-filter-spec'
import { clearIndustryMappingCache } from '@/lib/sourcing/industry-mapping'
import { seniorityFixture } from '@/test-utils/seniority-fixture'
import { aTargetableCode } from '@/test-utils/geography-fixture'
import { logger } from '@/lib/logger'

const derivation = vi.hoisted(() => ({
  calls: [] as unknown[],
  outcome: 'derive' as 'derive' | 'throw',
}))

const SET = {
  dimensions: [
    { key: 'placeholder_condition', statement: 'Placeholder condition.', source: 'Placeholder source', role: 'required', establishable: true },
  ],
  derived_at: new Date(0).toISOString(),
  model: 'test',
}

vi.mock('@/agents/fit-dimensions-agent', () => ({
  deriveFitDimensions: async (input: unknown) => {
    derivation.calls.push(input)
    if (derivation.outcome === 'throw') throw new Error('placeholder derivation failure')
    return SET
  },
}))

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

vi.mock('@/lib/sourcing/resolve-icp-geography', () => ({
  resolveIcpGeography: async () => ({ countries: [aTargetableCode()], removed_by_exclusion: [], unresolved_phrases: [] }),
}))

const ORG = '11111111-2222-3333-4444-555555555555'

interface Row { [k: string]: unknown }

function makeSupabase(tables: Record<string, Row[]>) {
  const updates: { table: string; payload: Row }[] = []
  function unimplemented(m: string) {
    return () => { throw new Error(`fake supabase does not implement ${m}()`) }
  }
  const client = {
    from(table: string) {
      const eqs: [string, unknown][] = []
      const notNulls: string[] = []
      let pending: Row | null = null
      const match = () => (tables[table] ?? [])
        .filter(r => eqs.every(([c, v]) => r[c] === v))
        .filter(r => notNulls.every(c => r[c] !== null && r[c] !== undefined))
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (c: string, v: unknown) => { eqs.push([c, v]); return chain },
        is: (c: string, v: unknown) => { eqs.push([c, v]); return chain },
        not: (c: string, op: string, v: unknown) => {
          if (op !== 'is' || v !== null) throw new Error(`fake supports only .not(col,'is',null)`)
          notNulls.push(c)
          return chain
        },
        update: (p: Row) => { pending = p; return chain },
        single: async () => {
          const rows = match()
          return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: `no single row for ${table}` } }
        },
        then: (resolve: (v: unknown) => unknown) => {
          if (pending) {
            const matched = match()
            updates.push({ table, payload: pending })
            for (const row of matched) Object.assign(row, pending)
            return Promise.resolve({ data: matched, error: null }).then(resolve)
          }
          return Promise.resolve({ data: match(), error: null }).then(resolve)
        },
        limit: unimplemented('limit'),
        insert: unimplemented('insert'),
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

function icpContent() {
  const tier = (industry: string) => ({
    company_profile: { headcount: '5-20 people', industries: [industry] },
    buyer_profile: { title: 'a role this market uses', seniority: 'as the document states it' },
    disqualifiers: ['Placeholder rule-out.'],
  })
  return {
    jtbd_statement: 'j', summary: 's',
    tier_1: tier(CANONICAL_INDUSTRIES[0]), tier_2: tier(CANONICAL_INDUSTRIES[1]),
    tier_3: { company_profile: { headcount: '51-100 people', industries: [] } },
  }
}

function writtenSpec(updates: { table: string; payload: Row }[]): Record<string, unknown> {
  const specWrites = updates.filter(u => u.table === 'strategy_documents' && 'icp_filter_spec' in u.payload)
  expect(specWrites.length, 'persist must write a spec for this test to mean anything').toBe(1)
  return specWrites[0].payload.icp_filter_spec as Record<string, unknown>
}

function run() {
  const content = icpContent()
  const { client, updates } = makeSupabase({
    strategy_documents: [{ id: 'doc-1', organisation_id: ORG, document_type: 'icp', content }],
    organisations: [{ id: ORG, sourcing_revenue_filter_enabled: false }],
    prospects: [],
  })
  return { content, updates, done: persistIcpFilterSpec(client, 'doc-1') }
}

beforeEach(() => {
  clearIndustryMappingCache()
  vi.restoreAllMocks()
  derivation.calls.length = 0
  derivation.outcome = 'derive'
})

describe('persistIcpFilterSpec fixes the fit dimensions when the profile is approved', () => {
  it('stores the derived list on the spec it writes', async () => {
    const { updates, done } = run()
    await done
    expect(writtenSpec(updates).fit_dimensions).toEqual(SET)
  })

  it('derives from the approved document itself, once', async () => {
    const { content, done } = run()
    await done
    expect(derivation.calls).toEqual([{ doc: content }])
  })

  it('a failed derivation still writes the spec, without a list, and says so', async () => {
    derivation.outcome = 'throw'
    const error = vi.spyOn(logger, 'error')
    const { updates, done } = run()
    await done
    const spec = writtenSpec(updates)
    expect(spec).not.toHaveProperty('fit_dimensions')
    expect(spec.job_titles).toEqual(['a-fragment'])
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/fit dimensions could not be derived/),
      expect.objectContaining({ organisation_id: ORG, error: 'placeholder derivation failure' }),
    )
  })
})
