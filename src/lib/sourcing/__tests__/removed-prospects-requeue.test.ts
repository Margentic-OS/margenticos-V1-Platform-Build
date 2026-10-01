// The batch-cap fix, and where its other half went.
//
// tierEnrichedBatch skips prospects that already carry a tiering_reason, so decided rows
// stop eating the batch cap. That filter freezes a removal verdict, and ADR-037 says it
// must never ship without something that thaws one.
//
// THE THAW USED TO BE TESTED HERE, AND IT HAS MOVED. Until ADR-061 it ran inside
// persistIcpFilterSpec, on every ICP promotion, whether or not the settings had changed.
// On 2026-09-30 that is how a wording edit put 62 removed prospects back in front of a
// search nobody had chosen. From ADR-061 step 4 a promotion re-queues NOTHING, which
// propose-icp-filter-spec.test.ts asserts for every kind of targeting edit, and the thaw
// returns in step 5 on the approval of a change that tiering reads.
//
// BETWEEN STEP 4 AND STEP 5 NOTHING THAWS A REMOVAL, and that is consistent rather than a
// gap: in that window nothing can change the live settings either, so no verdict was made
// under a rule that has since moved.
//
// The fake honours eq(), is(), not() and limit() by actually filtering and slicing,
// and throws on anything it does not implement. `tiering_reason: null` is set
// EXPLICITLY on every fixture row: the fake compares with ===, and an absent field
// would be `undefined`, which would filter the row out and make these tests pass for
// entirely the wrong reason.
// See CLAUDE.md, "A fake that does not honour a filter cannot test that filter".

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { tierEnrichedBatch } from '@/lib/sourcing/tiering-trigger'
import { clearIndustryMappingCache } from '@/lib/sourcing/industry-mapping'
import type { ICPFilterSpec } from '@/lib/agents/icp-filter-spec'

vi.mock('@sentry/nextjs', () => ({
  withScope: (fn: (s: unknown) => void) => fn({ setExtra() {}, setContext() {} }),
  captureMessage: () => {},
  captureException: () => {},
  flush: async () => true,
}))

const ORG = '11111111-2222-3333-4444-555555555555'
const OTHER_ORG = '99999999-8888-7777-6666-555555555555'

function spec(industries: string[]): ICPFilterSpec {
  return {
    job_titles: [], job_titles_excluded: [], seniority_levels: [],
    person_countries: [], company_countries: [],
    company_headcount_min: 0, company_headcount_max: 0,
    company_revenue_min: null, company_revenue_max: null,
    industries: industries as ICPFilterSpec['industries'],
    industries_excluded: [], keywords: [], keywords_excluded: [], notes: '',
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

interface Row { [k: string]: unknown }

function prospect(over: Partial<Row>): Row {
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
    tiering_reason: null,   // explicit, see header
    ...over,
  }
}

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
            then: (r: (v: unknown) => unknown) =>
              Promise.resolve({ data: null, error: null }).then(r),
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

function tieringTables(prospects: Row[], specIndustries = ['Management Consulting']) {
  return {
    strategy_documents: [{
      id: 'doc-1', organisation_id: ORG, document_type: 'icp', status: 'active',
      client_approval_status: 'approved', icp_filter_spec: spec(specIndustries),
    }],
    organisations: [{ id: ORG, client_review_enabled: true }],
    prospects,
    industry_tag_mappings: [],
    agent_runs: [],
  }
}

beforeEach(() => {
  clearIndustryMappingCache()
  vi.restoreAllMocks()
})

describe('tierEnrichedBatch: already-classified prospects do not eat the batch cap', () => {
  it('skips a prospect that already carries a tiering_reason', async () => {
    const { client } = makeSupabase(tieringTables([
      prospect({ id: 'removed', tiering_reason: 'industry_not_consulting', company_industry: 'restaurants' }),
      prospect({ id: 'fresh' }),
    ]))

    const result = await tierEnrichedBatch(client, ORG, 100)

    // Only the never-classified one is picked up.
    expect(result.prospects_classified).toBe(1)
  })

  it('is the whole bug: removals used to fill the cap and hide fresh prospects', async () => {
    // Three decided rows and one fresh one, with a cap of 3. Before the filter the
    // batch was the three removals and the fresh prospect was never reached, run
    // after run, while the run still reported "completed, 3 classified".
    const { client } = makeSupabase(tieringTables([
      prospect({ id: 'r1', tiering_reason: 'not_decision_maker', job_title: 'other-role' }),
      prospect({ id: 'r2', tiering_reason: 'not_decision_maker', job_title: 'other-role' }),
      prospect({ id: 'r3', tiering_reason: 'industry_not_consulting', company_industry: 'restaurants' }),
      prospect({ id: 'fresh' }),
    ]))

    const result = await tierEnrichedBatch(client, ORG, 3)

    expect(result.prospects_classified).toBe(1)
    expect(result.tier_1_count).toBe(1)
  })

  it('still classifies prospects that have never been through tiering', async () => {
    const { client } = makeSupabase(tieringTables([
      prospect({ id: 'a' }),
      prospect({ id: 'b' }),
    ]))

    const result = await tierEnrichedBatch(client, ORG, 100)
    expect(result.prospects_classified).toBe(2)
  })
})
