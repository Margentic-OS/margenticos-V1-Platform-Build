// A REFUSED SPEC IS WRITTEN ON THE DOCUMENT, AND LABELLED WITH ITS REAL CAUSE.
//
// persistIcpFilterSpec runs after a new ICP version is already live and the request has
// already reported success. When it refused, two things were wrong:
//
//   the label   every refusal was logged and tagged "non-canonical industries", whatever
//               refused. The one in Sentry on 2026-09-08 was a blank headcount.
//   the silence the refusal reached Sentry and nowhere else, so the operator was told the
//               change worked. Three versions in a row went live with no spec that day.
//
// These check the refusal that is WRITTEN (strategy_documents.icp_filter_spec_refusal) and the
// label that is REPORTED, on the real function.
//
// The fake is a copy of the one in persist-reads-revenue-opt-in.test.ts: it honours every
// filter persist applies, and throws on any method it does not implement.
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

const control = vi.hoisted(() => ({
  geographyThrows: null as Error | null,
  criterionThrows: null as Error | null,
  captured: [] as { tags: Record<string, unknown>; extras: Record<string, unknown> }[],
}))

vi.mock('@sentry/nextjs', () => {
  let extras: Record<string, unknown> = {}
  return {
    withScope: (fn: (s: unknown) => void) => {
      extras = {}
      fn({ setExtra: (k: string, v: unknown) => { extras[k] = v }, setContext() {} })
    },
    captureMessage: () => {},
    captureException: (_err: unknown, ctx?: { tags?: Record<string, unknown>; extra?: Record<string, unknown> }) => {
      control.captured.push({ tags: ctx?.tags ?? {}, extras: { ...extras, ...(ctx?.extra ?? {}) } })
    },
    flush: async () => true,
  }
})

vi.mock('@/agents/buyer-criterion-agent', () => ({
  deriveBuyerCriterionWithVocabulary: async () => {
    if (control.criterionThrows) throw control.criterionThrows
    return {
      criterion: {
        status: 'derived', accept: [{ fragment: 'a-fragment', rank: 'primary' }], reject: [],
        statement: 's', evidence: [], unsettled_reason: null, sanity: null,
        derived_at: new Date(0).toISOString(), model: 'test',
      },
      vocabulary: { sells: 's', usedFor: 'u', nameWords: [] },
      seniority: seniorityFixture(),
    }
  },
}))

vi.mock('@/lib/sourcing/resolve-icp-geography', () => ({
  resolveIcpGeography: async () => {
    if (control.geographyThrows) throw control.geographyThrows
    return { countries: [aTargetableCode()], removed_by_exclusion: [], unresolved_phrases: [] }
  },
}))

const ORG = '11111111-2222-3333-4444-555555555555'

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

function icpContent(headcount: [string, string], industry: string = CANONICAL_INDUSTRIES[0]) {
  const tier = (h: string, ind: string) => ({
    company_profile: { revenue_range: '', headcount: h, industries: [ind] },
    buyer_profile: { title: 'a role this market uses', seniority: 'as the document states it' },
    disqualifiers: [],
  })
  return {
    jtbd_statement: 'j',
    summary: 's',
    tier_1: tier(headcount[0], industry),
    tier_2: tier(headcount[1], CANONICAL_INDUSTRIES[1]),
    tier_3: { company_profile: { revenue_range: '', headcount: '', industries: [] } },
  }
}

function setup(content: unknown, existingRefusal: unknown = null) {
  const doc: Row = {
    id: 'doc-1', organisation_id: ORG, document_type: 'icp', content,
    icp_filter_spec: null, icp_filter_spec_refusal: existingRefusal,
  }
  const fake = makeSupabase({
    strategy_documents: [doc],
    organisations: [{ id: ORG, sourcing_revenue_filter_enabled: false }],
    prospects: [],
  })
  return { ...fake, doc }
}

beforeEach(() => {
  clearIndustryMappingCache()
  vi.restoreAllMocks()
  control.geographyThrows = null
  control.criterionThrows = null
  control.captured.length = 0
})

describe('persistIcpFilterSpec — a refusal is written on the document', () => {
  it('a blank headcount: no spec, and the refusal names no_headcount_bound', async () => {
    const { client, updates, doc } = setup(icpContent(['', '']))
    await persistIcpFilterSpec(client, 'doc-1')

    expect(updates.some(u => 'icp_filter_spec' in u.payload)).toBe(false)
    expect(doc.icp_filter_spec).toBeNull()
    expect(doc.icp_filter_spec_refusal).toMatchObject({
      reason: 'no_headcount_bound',
      detail: expect.stringMatching(/neither tier establishes a lower headcount bound/),
    })
  })

  it('the refusal is written on THIS document only', async () => {
    const { client, updates } = setup(icpContent(['', '']))
    await persistIcpFilterSpec(client, 'doc-1')
    const refusalWrites = updates.filter(u => 'icp_filter_spec_refusal' in u.payload)
    expect(refusalWrites).toHaveLength(1)
    expect(refusalWrites[0].matched.map(r => r.id)).toEqual(['doc-1'])
  })

  it('geography that cannot be resolved: no spec, refusal geography_unresolved', async () => {
    control.geographyThrows = new Error('the document names no recognisable place')
    const { client, doc } = setup(icpContent(['5-20 people', '21-50 people']))
    await persistIcpFilterSpec(client, 'doc-1')

    expect(doc.icp_filter_spec).toBeNull()
    expect(doc.icp_filter_spec_refusal).toMatchObject({
      reason: 'geography_unresolved',
      detail: 'the document names no recognisable place',
    })
  })

  it('a failed buyer criterion call is named as the cause, not the seniority rule it trips', async () => {
    control.criterionThrows = new Error('model call timed out')
    const { client, doc } = setup(icpContent(['5-20 people', '21-50 people']))
    await persistIcpFilterSpec(client, 'doc-1')

    expect(doc.icp_filter_spec).toBeNull()
    expect(doc.icp_filter_spec_refusal).toMatchObject({
      reason: 'buyer_criterion_failed',
      detail: expect.stringMatching(/model call timed out.*no seniority bands/),
    })
  })

  it('a clean build stores the spec and CLEARS an earlier refusal in the same write', async () => {
    const { client, updates, doc } = setup(
      icpContent(['5-20 people', '21-50 people']),
      { reason: 'no_headcount_bound', detail: 'from an earlier attempt', recorded_at: '2026-09-08T00:00:00Z' },
    )
    await persistIcpFilterSpec(client, 'doc-1')

    const specWrite = updates.find(u => 'icp_filter_spec' in u.payload)
    expect(specWrite?.payload.icp_filter_spec).toBeTruthy()
    expect(specWrite?.payload).toHaveProperty('icp_filter_spec_refusal', null)
    expect(doc.icp_filter_spec_refusal).toBeNull()
  })
})

describe('persistIcpFilterSpec — the label names the real cause', () => {
  it('a blank headcount is reported as no_headcount_bound, never as an industry problem', async () => {
    const error = vi.spyOn(logger, 'error')
    const { client } = setup(icpContent(['', '']))
    await persistIcpFilterSpec(client, 'doc-1')

    expect(control.captured).toHaveLength(1)
    expect(control.captured[0].tags.refusal_reason).toBe('no_headcount_bound')
    expect(control.captured[0].extras.error_type).toBe('no_headcount_bound')

    const messages = error.mock.calls.map(c => String(c[0]))
    expect(messages.some(m => m.includes('(no_headcount_bound)'))).toBe(true)
    expect(messages.some(m => /non-canonical/i.test(m))).toBe(false)
  })

  it('a non-canonical industry is reported as non_canonical_industry', async () => {
    const { client, doc } = setup(icpContent(['5-20 people', '21-50 people'], 'Not A Canonical Name'))
    await persistIcpFilterSpec(client, 'doc-1')

    expect(control.captured[0].tags.refusal_reason).toBe('non_canonical_industry')
    expect(control.captured[0].extras.error_type).toBe('non_canonical_industry')
    expect(doc.icp_filter_spec_refusal).toMatchObject({ reason: 'non_canonical_industry' })
  })
})
