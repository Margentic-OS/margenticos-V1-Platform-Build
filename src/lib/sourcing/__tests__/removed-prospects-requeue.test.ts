// The batch-cap fix and the re-queue that must ship with it.
//
// Two halves of one behaviour, tested together on purpose:
//   1. tierEnrichedBatch skips prospects that already carry a tiering_reason, so
//      decided rows stop eating the batch cap.
//   2. persistIcpFilterSpec clears tiering_reason for the org's removed prospects,
//      so the filter in (1) does not turn a removal into a permanent verdict.
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
import { persistIcpFilterSpec } from '@/lib/sourcing/persist-icp-filter-spec'
import { clearIndustryMappingCache } from '@/lib/sourcing/industry-mapping'
import { logger } from '@/lib/logger'
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
    industries: industries as ICPFilterSpec['industries'],
    industries_excluded: [], keywords: [], keywords_excluded: [], notes: '',
  }
}

interface Row { [k: string]: unknown }

function prospect(over: Partial<Row>): Row {
  return {
    id: 'p1',
    organisation_id: ORG,
    email_status: 'verified',
    enrichment_status: 'enriched',
    job_title: 'Founder',
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

// A real IcpDocument shape. deriveFilterSpec reads tier_1/tier_2 company_profile
// directly, so a loose fixture throws inside persistIcpFilterSpec's catch-all and
// the function returns BEFORE the re-queue, which looks exactly like the re-queue
// not working.
function icpContent() {
  return {
    jtbd_statement: 'Grow pipeline without hiring.',
    summary: 'Founder-led B2B consulting firms.',
    tier_1: {
      company_profile: {
        revenue_range: 'GBP 500K to 5M',
        headcount: '5-20 people',
        industries: ['Management Consulting'],
      },
      buyer_profile: { title: 'Founder', seniority: 'owner' },
      disqualifiers: [],
    },
    tier_2: {
      company_profile: {
        revenue_range: 'GBP 500K to 5M',
        headcount: '21-50 people',
        industries: ['Strategy Consulting'],
      },
      buyer_profile: { title: 'Founder', seniority: 'owner' },
      disqualifiers: [],
    },
    tier_3: {
      company_profile: {
        revenue_range: 'GBP 500K to 5M',
        headcount: '51-100 people',
        industries: [],
      },
    },
  }
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
      prospect({ id: 'r1', tiering_reason: 'not_decision_maker', job_title: 'Intern' }),
      prospect({ id: 'r2', tiering_reason: 'not_decision_maker', job_title: 'Intern' }),
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

describe('persistIcpFilterSpec: re-queue on spec change', () => {
  function persistTables(prospects: Row[]) {
    return {
      strategy_documents: [{
        id: 'doc-1',
        organisation_id: ORG,
        document_type: 'icp',
        content: icpContent(),
      }],
      prospects,
    }
  }

  it('clears tiering_reason for the org\'s removed prospects', async () => {
    const rows = [
      prospect({ id: 'removed', tiering_reason: 'industry_not_consulting' }),
      prospect({ id: 'fresh' }),
      prospect({ id: 'survivor', sourced_tier: 'tier_1', tiering_reason: 'tier_1 (score 90)' }),
    ]
    const { client } = makeSupabase(persistTables(rows))

    await persistIcpFilterSpec(client, 'doc-1')

    expect(rows.find(r => r.id === 'removed')!.tiering_reason).toBeNull()
    // A survivor keeps its verdict: re-tiering something already published to a
    // client is a different decision with different consequences.
    expect(rows.find(r => r.id === 'survivor')!.tiering_reason).toBe('tier_1 (score 90)')
    expect(rows.find(r => r.id === 'survivor')!.sourced_tier).toBe('tier_1')
  })

  it('does not touch another organisation\'s removed prospects', async () => {
    const rows = [
      prospect({ id: 'mine', tiering_reason: 'not_decision_maker' }),
      prospect({ id: 'theirs', organisation_id: OTHER_ORG, tiering_reason: 'not_decision_maker' }),
    ]
    const { client } = makeSupabase(persistTables(rows))

    await persistIcpFilterSpec(client, 'doc-1')

    expect(rows.find(r => r.id === 'mine')!.tiering_reason).toBeNull()
    expect(rows.find(r => r.id === 'theirs')!.tiering_reason).toBe('not_decision_maker')
  })

  it('logs the re-queue at warn, with the org and the count', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    const { client } = makeSupabase(persistTables([
      prospect({ id: 'r1', tiering_reason: 'not_decision_maker' }),
      prospect({ id: 'r2', tiering_reason: 'industry_not_consulting' }),
      prospect({ id: 'fresh' }),
    ]))

    await persistIcpFilterSpec(client, 'doc-1')

    const line = warn.mock.calls.find(c => String(c[0]).includes('re-queued for tiering'))
    expect(line).toBeDefined()

    const payload = line![1] as Record<string, unknown>
    expect(payload.requeued_count).toBe(2)
    expect(payload.organisation_id).toBe(ORG)
  })

  it('logs at info, not warn, when there is nothing to re-queue', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {})

    const { client } = makeSupabase(persistTables([prospect({ id: 'fresh' })]))

    await persistIcpFilterSpec(client, 'doc-1')

    expect(warn.mock.calls.find(c => String(c[0]).includes('re-queued for tiering'))).toBeUndefined()
    expect(info.mock.calls.find(c => String(c[0]).includes('no removed prospects to re-queue'))).toBeDefined()
  })
})

describe('the two halves together', () => {
  it('a removed prospect is re-classified after a spec change, and not before', async () => {
    const rows = [prospect({ id: 'removed', tiering_reason: 'industry_not_consulting' })]

    // Before: the tiering run does not see it.
    const first = makeSupabase(tieringTables(rows))
    expect((await tierEnrichedBatch(first.client, ORG, 100)).prospects_classified).toBe(0)

    // A new filter spec is stored for the organisation.
    const persist = makeSupabase({
      strategy_documents: [{
        id: 'doc-1', organisation_id: ORG, document_type: 'icp',
        content: icpContent(),
      }],
      prospects: rows,
    })
    await persistIcpFilterSpec(persist.client, 'doc-1')

    // After: it is back in the queue and gets a fresh verdict.
    const second = makeSupabase(tieringTables(rows))
    expect((await tierEnrichedBatch(second.client, ORG, 100)).prospects_classified).toBe(1)
  })
})
