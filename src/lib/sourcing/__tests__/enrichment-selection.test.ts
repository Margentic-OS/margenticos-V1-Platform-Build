// The shared eligibility predicates and the buyer gate that runs before any spend.
//
// RULE ZERO: every fragment and title here is an abstract token. See buyer-criterion.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  selectEnrichmentEligible,
  gateProspectsBeforeEnrichment,
  loadBuyerCriterion,
  type SelectedProspect,
} from '@/lib/sourcing/enrichment-selection'
import type { BuyerCriterion } from '@/lib/sourcing/buyer-criterion'

vi.mock('@sentry/nextjs', () => ({
  withScope: (fn: (s: unknown) => void) => fn({ setLevel() {}, setTag() {}, setExtra() {} }),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}))

const ORG = '11111111-2222-3333-4444-555555555555'

function criterion(over: Partial<BuyerCriterion> = {}): BuyerCriterion {
  return {
    status: 'derived',
    accept: [{ fragment: 'alpha', rank: 'primary' }],
    reject: [],
    statement: 'Fixture.',
    evidence: [],
    unsettled_reason: null,
    sanity: null,
    derived_at: '2026-09-02T00:00:00.000Z',
    model: 'test',
    ...over,
  }
}

interface Recorded {
  table: string
  op: 'select' | 'update'
  filters: Array<[string, string, unknown]>
  payload?: Record<string, unknown>
}

/**
 * A fake that THROWS on anything it does not implement.
 *
 * Silently returning the chain from an unimplemented method is what made three separate
 * guards untestable in this codebase: the assertion still reads as being about the
 * filter, the filter is never applied, and deleting it from the real query fails nothing.
 */
function makeSupabase(opts: {
  spec?: unknown
  specError?: string
  updateError?: string
} = {}) {
  const recorded: Recorded[] = []

  const client = {
    from(table: string) {
      const entry: Recorded = { table, op: 'select', filters: [] }

      const chain: Record<string, unknown> = {
        select() { recorded.push(entry); return chain },
        update(payload: Record<string, unknown>) {
          entry.op = 'update'
          entry.payload = payload
          recorded.push(entry)
          return chain
        },
        eq(col: string, val: unknown) { entry.filters.push(['eq', col, val]); return chain },
        is(col: string, val: unknown) { entry.filters.push(['is', col, val]); return chain },
        not(col: string, _op: string, val: unknown) { entry.filters.push(['not', col, val]); return chain },
        in(col: string, val: unknown) { entry.filters.push(['in', col, val]); return chain },
        order() { return chain },
        limit() { return chain },
        maybeSingle() {
          if (opts.specError) return Promise.resolve({ data: null, error: { message: opts.specError } })
          return Promise.resolve({ data: { icp_filter_spec: opts.spec ?? null }, error: null })
        },
        // The update path is awaited directly, with no terminal method.
        then(resolve: (v: unknown) => void) {
          return Promise.resolve(
            opts.updateError ? { data: null, error: { message: opts.updateError } } : { data: [], error: null },
          ).then(resolve)
        },
      }

      for (const name of ['single', 'delete', 'insert', 'upsert', 'or', 'gt', 'lt', 'match']) {
        chain[name] = () => { throw new Error(`fake supabase does not implement ${name}()`) }
      }

      return chain
    },
  } as unknown as SupabaseClient

  return { client, recorded }
}

const prospects: SelectedProspect[] = [
  { id: 'p-accept', source_person_key: 'k1', job_title: 'alpha' },
  { id: 'p-reject', source_person_key: 'k2', job_title: 'omega' },
  { id: 'p-notitle', source_person_key: 'k3', job_title: null },
]

beforeEach(() => vi.restoreAllMocks())

describe('selectEnrichmentEligible: one definition of eligible, read by both paths', () => {
  it('applies all five predicates', () => {
    const { client, recorded } = makeSupabase()
    selectEnrichmentEligible(client, ORG)

    const q = recorded.find(r => r.table === 'prospects')!
    expect(q.filters).toEqual([
      ['eq', 'organisation_id', ORG],
      ['eq', 'sourcing_review_status', 'approved'],
      ['is', 'enrichment_status', null],
      ['is', 'enrichment_credit_consumed_at', null],
      ['is', 'tiering_reason', null],
    ])
  })

  it('excludes rows that already carry a tiering_reason, which is what makes a rejection terminal', () => {
    // Deleting this predicate from the real query is what would rebuild the retry loop:
    // a gate-rejected prospect keeps enrichment_status NULL, so without it every run
    // would select, re-reject and re-select the same prospect forever.
    const { client, recorded } = makeSupabase()
    selectEnrichmentEligible(client, ORG)
    expect(recorded[0].filters).toContainEqual(['is', 'tiering_reason', null])
  })
})

describe('loadBuyerCriterion', () => {
  it('returns the criterion from the active spec', async () => {
    const { client } = makeSupabase({ spec: { buyer_criterion: criterion() } })
    expect((await loadBuyerCriterion(client, ORG))?.status).toBe('derived')
  })

  it('returns null when the spec has no criterion', async () => {
    const { client } = makeSupabase({ spec: { industries: [] } })
    expect(await loadBuyerCriterion(client, ORG)).toBeNull()
  })

  it('returns null rather than throwing when the read fails', async () => {
    const { client } = makeSupabase({ specError: 'boom' })
    expect(await loadBuyerCriterion(client, ORG)).toBeNull()
  })

  it('fails open rather than throwing when the read itself throws', async () => {
    // Not the same as the error-shaped failure above. An exception escaping the load would
    // propagate into the enrichment run and abort the whole batch, which is failing CLOSED
    // by accident in the one path designed to fail open. Found by a fake that threw on a
    // table it did not implement, which is exactly what a strict fake is for.
    const throwing = {
      from() { throw new Error('read exploded') },
    } as unknown as SupabaseClient

    await expect(loadBuyerCriterion(throwing, ORG)).resolves.toBeNull()

    const result = await gateProspectsBeforeEnrichment(throwing, ORG, prospects)
    expect(result.passed).toHaveLength(3)
    expect(result.warning).toContain('no buyer criterion yet')
  })

  it('scopes the read to one organisation', async () => {
    const { client, recorded } = makeSupabase({ spec: {} })
    await loadBuyerCriterion(client, ORG)
    expect(recorded[0].filters).toContainEqual(['eq', 'organisation_id', ORG])
  })
})

describe('gateProspectsBeforeEnrichment', () => {
  it('rejects before spend and records a real verdict', async () => {
    const { client, recorded } = makeSupabase({ spec: { buyer_criterion: criterion() } })
    const result = await gateProspectsBeforeEnrichment(client, ORG, prospects)

    expect(result.rejected.map(p => p.id)).toEqual(['p-reject'])
    expect(result.warning).toBeNull()

    const update = recorded.find(r => r.op === 'update')!
    // The SAME shape every other rejection has: a REMOVAL_REASONS code in tiering_reason,
    // and sourced_tier left NULL. Not a new column and not a new vocabulary, so the
    // existing removed and removed_by_reason counts pick it up unchanged.
    expect(update.payload).toEqual({ tiering_reason: 'not_decision_maker' })
    expect(update.filters).toContainEqual(['in', 'id', ['p-reject']])
    expect(update.filters).toContainEqual(['eq', 'organisation_id', ORG])
  })

  it('passes a prospect with no title rather than guessing', async () => {
    const { client } = makeSupabase({ spec: { buyer_criterion: criterion() } })
    const result = await gateProspectsBeforeEnrichment(client, ORG, prospects)
    expect(result.passed.map(p => p.id)).toEqual(['p-accept', 'p-notitle'])
  })

  it('writes nothing when nothing is rejected', async () => {
    const { client, recorded } = makeSupabase({ spec: { buyer_criterion: criterion() } })
    await gateProspectsBeforeEnrichment(client, ORG, [prospects[0]])
    expect(recorded.find(r => r.op === 'update')).toBeUndefined()
  })

  describe('fails OPEN and warns', () => {
    // Failing closed would stop a client's pipeline with no error anyone would think to
    // look for. The warning is returned so the route can put it in front of the operator
    // who clicked the button, not only in a log stream.
    it('when the client has no criterion yet', async () => {
      const { client, recorded } = makeSupabase({ spec: { industries: [] } })
      const result = await gateProspectsBeforeEnrichment(client, ORG, prospects)

      expect(result.passed).toHaveLength(3)
      expect(result.rejected).toHaveLength(0)
      expect(result.warning).toContain('no buyer criterion yet')
      expect(recorded.find(r => r.op === 'update')).toBeUndefined()
    })

    it('when the documents did not settle who decides', async () => {
      const { client } = makeSupabase({ spec: { buyer_criterion: criterion({ status: 'unsettled' }) } })
      const result = await gateProspectsBeforeEnrichment(client, ORG, prospects)
      expect(result.passed).toHaveLength(3)
      expect(result.warning).toContain('do not settle')
    })

    it('when the criterion is outside the sanity band', async () => {
      const { client } = makeSupabase({ spec: { buyer_criterion: criterion({ status: 'out_of_band' }) } })
      const result = await gateProspectsBeforeEnrichment(client, ORG, prospects)
      expect(result.passed).toHaveLength(3)
      expect(result.warning).toContain('sanity band')
    })
  })

  it('does not enrich the rejected ones when the verdict fails to persist', async () => {
    // The verdict is lost and they will be selected again, which is recoverable.
    // Enriching them anyway would spend money on prospects the client would not email.
    const { client } = makeSupabase({
      spec: { buyer_criterion: criterion() },
      updateError: 'write failed',
    })
    const result = await gateProspectsBeforeEnrichment(client, ORG, prospects)
    expect(result.passed.map(p => p.id)).not.toContain('p-reject')
  })

  it('does nothing at all for an empty batch', async () => {
    const { client, recorded } = makeSupabase()
    const result = await gateProspectsBeforeEnrichment(client, ORG, [])
    expect(result).toEqual({ passed: [], rejected: [], warning: null })
    expect(recorded).toHaveLength(0)
  })
})
