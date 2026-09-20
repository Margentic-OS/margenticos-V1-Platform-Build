// THE APPROVAL STEP READS THE HEADCOUNT THE CLIENT TYPED, AND A FAILED READ IS "NOT ANSWERED".
//
// ─── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────────────
//
// It was written because a mutation survived. deriveFilterSpec has its own tests and so does
// the reader; both were green while the ARGUMENT CONNECTING THEM was deleted. A test on each
// end of a handoff proves both ends and says nothing about the handoff. Here that handoff is
// the whole feature: without it, a client who answered the headcount question is sourced
// against a range parsed out of prose anyway, and every other test still passes.
//
// The fake is a copy of the one in persist-reads-revenue-opt-in.test.ts, with maybeSingle
// implemented, because the buyer-profile read uses it. It throws on any method it does not
// implement: a fake that silently returns a chain cannot test a filter.
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

vi.mock('@/agents/fit-dimensions-agent', () => ({
  deriveFitDimensions: async () => ({
    dimensions: [], derived_at: new Date(0).toISOString(), model: 'test',
  }),
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

// What the tiers say. Parsed, this document yields 5 to 50, which is a well-formed range and
// a different one from anything a test states, so the two sources are always distinguishable.
const DOC_PARSES_TO = { min: 5, max: 50 }

interface Row { [k: string]: unknown }

function makeSupabase(tables: Record<string, Row[]>, throwOnTable?: string) {
  const updates: { table: string; payload: Row }[] = []
  function unimplemented(m: string) {
    return () => { throw new Error(`fake supabase does not implement ${m}()`) }
  }
  const client = {
    from(table: string) {
      // A READ THAT GENUINELY FAILS. Added because a mutation survived without it: an
      // ABSENT table is not a broken read, it is an empty one, and the code turns that into
      // an empty profile and a null pair like any other organisation with no row. The
      // fail-open branch is only reached when the read THROWS, so a test for it has to make
      // it throw. The previous version of this test was named for a throw that never
      // happened, which is this repository's most frequent defect in miniature.
      if (table === throwOnTable) {
        throw new Error(`fake supabase: read of ${table} failed`)
      }
      const eqs: [string, unknown][] = []
      let limitN: number | null = null
      let pending: Row | null = null
      const match = () => {
        const rows = (tables[table] ?? []).filter(r => eqs.every(([c, v]) => r[c] === v))
        return limitN === null ? rows : rows.slice(0, limitN)
      }
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (c: string, v: unknown) => { eqs.push([c, v]); return chain },
        is: (c: string, v: unknown) => { eqs.push([c, v]); return chain },
        not: (c: string, op: string, v: unknown) => {
          if (op !== 'is' || v !== null) throw new Error("fake supports only .not(col,'is',null)")
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
        // HONOURED, not swallowed. The buyer-profile read filters on organisation_id and
        // ends in maybeSingle; a fake returning every row would make the isolation test
        // below pass while the filter was absent.
        maybeSingle: async () => {
          const rows = match()
          return { data: rows[0] ?? null, error: null }
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
        in: unimplemented('in'),
        or: unimplemented('or'),
        order: unimplemented('order'),
        delete: unimplemented('delete'),
      }
      return chain
    },
  } as unknown as SupabaseClient
  return { client, updates }
}

function icpContent() {
  const tier = (headcount: string, industry: string) => ({
    company_profile: { revenue_range: 'GBP 500K to 5M', headcount, industries: [industry] },
    buyer_profile: { title: 'a role this market uses', seniority: 'as the document states it' },
    disqualifiers: [],
  })
  return {
    jtbd_statement: 'j',
    summary: 's',
    tier_1: tier(`${DOC_PARSES_TO.min}-20 people`, CANONICAL_INDUSTRIES[0]),
    tier_2: tier(`21-${DOC_PARSES_TO.max} people`, CANONICAL_INDUSTRIES[1]),
    tier_3: {
      company_profile: { revenue_range: 'GBP 500K to 5M', headcount: '51-100 people', industries: [] },
    },
  }
}

function tables(buyerProfiles: Row[] | null): Record<string, Row[]> {
  return {
    strategy_documents: [
      { id: 'doc-1', organisation_id: ORG, document_type: 'icp', content: icpContent() },
    ],
    organisations: [{ id: ORG, sourcing_revenue_filter_enabled: false }],
    prospects: [],
    ...(buyerProfiles ? { intake_buyer_profile: buyerProfiles } : {}),
  }
}

function writtenSpec(updates: { table: string; payload: Row }[]): Record<string, unknown> {
  const specWrites = updates.filter(
    u => u.table === 'strategy_documents' && 'icp_filter_spec' in u.payload,
  )
  expect(
    specWrites.length,
    'persist must write a spec for this test to mean anything',
  ).toBeGreaterThan(0)
  return specWrites[specWrites.length - 1].payload.icp_filter_spec as Record<string, unknown>
}

beforeEach(() => {
  clearIndustryMappingCache()
  vi.restoreAllMocks()
})

describe('persistIcpFilterSpec reads the headcount this client typed', () => {
  it('the stated pair reaches the written spec, and the document prose does not', async () => {
    const { client, updates } = makeSupabase(tables([
      { organisation_id: ORG, buyer_headcount_min: 200, buyer_headcount_max: 900 },
    ]))
    await persistIcpFilterSpec(client, 'doc-1')
    const spec = writtenSpec(updates)
    expect(spec.company_headcount_min).toBe(200)
    expect(spec.company_headcount_max).toBe(900)
  })

  it('the document parses to something else, so the test above distinguishes the two', async () => {
    // POSITIVE CONTROL. Without this, a spec of 5 to 50 from a stated pair of 5 to 50 would
    // be indistinguishable from the argument never being passed at all.
    const { client, updates } = makeSupabase(tables(null))
    await persistIcpFilterSpec(client, 'doc-1')
    const spec = writtenSpec(updates)
    expect(spec.company_headcount_min).toBe(DOC_PARSES_TO.min)
    expect(spec.company_headcount_max).toBe(DOC_PARSES_TO.max)
  })

  it('an organisation with no row is on the document path, as before', async () => {
    const { client, updates } = makeSupabase(tables([]))
    const spec = writtenSpec((await persistIcpFilterSpec(client, 'doc-1'), updates))
    expect(spec.company_headcount_min).toBe(DOC_PARSES_TO.min)
    expect(spec.company_headcount_max).toBe(DOC_PARSES_TO.max)
  })

  it("reads THIS organisation only: another organisation's answer never decides it", async () => {
    // Agent isolation at the application layer. A read that dropped its organisation filter
    // would see the other row and source this client against somebody else's answer.
    const { client, updates } = makeSupabase(tables([
      { organisation_id: OTHER_ORG, buyer_headcount_min: 1, buyer_headcount_max: 2 },
    ]))
    await persistIcpFilterSpec(client, 'doc-1')
    const spec = writtenSpec(updates)
    expect(spec.company_headcount_min).toBe(DOC_PARSES_TO.min)
    expect(spec.company_headcount_max).toBe(DOC_PARSES_TO.max)
  })

  it('the notes say which source produced the pair', async () => {
    const { client, updates } = makeSupabase(tables([
      { organisation_id: ORG, buyer_headcount_min: 200, buyer_headcount_max: 900 },
    ]))
    await persistIcpFilterSpec(client, 'doc-1')
    expect(writtenSpec(updates).notes).toContain('typed into their intake')
  })

  it('a read that THROWS leaves the client on the document path and writes a spec anyway', async () => {
    // FAILS OPEN. A failed spec derivation stops sourcing until a human re-approves; losing
    // one binding does not. So a broken read must land on the document path, which is where
    // every client was before this existed, and must not leave a default pair behind it.
    const { client, updates } = makeSupabase(tables(null), 'intake_buyer_profile')
    await persistIcpFilterSpec(client, 'doc-1')
    const spec = writtenSpec(updates)
    expect(spec.company_headcount_min).toBe(DOC_PARSES_TO.min)
    expect(spec.company_headcount_max).toBe(DOC_PARSES_TO.max)
    expect(spec.notes).toContain('parsed from the tier headcount prose')
  })

  it('and that read really did throw, so the test above is not the absent-table case', async () => {
    // POSITIVE CONTROL. An absent table and a failing read reach the same spec by different
    // routes, and only one of them exercises the catch. Without this, the test above would
    // pass just as well with throwOnTable never wired up.
    const warn = vi.spyOn(logger, 'warn')
    const { client } = makeSupabase(tables(null), 'intake_buyer_profile')
    await persistIcpFilterSpec(client, 'doc-1')
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/could not read the buyer-targeting answers/),
      expect.objectContaining({ organisation_id: ORG }),
    )
  })

  it('an ABSENT table is an empty read, not a failed one, and logs no warning', async () => {
    // The other side of that distinction, stated so the two cannot be confused again.
    const warn = vi.spyOn(logger, 'warn')
    const { client, updates } = makeSupabase(tables(null))
    await persistIcpFilterSpec(client, 'doc-1')
    expect(writtenSpec(updates).notes).toContain('parsed from the tier headcount prose')
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringMatching(/could not read the buyer-targeting answers/),
      expect.anything(),
    )
  })
})
