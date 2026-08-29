// Tests for the read-only export harness.
//
// TWO THINGS ARE WORTH TESTING HERE AND THEY ARE BOTH GUARDS, NOT FEATURES.
//
// The proxy's value is entirely in what it REFUSES, so a test that only proves a select
// works would pass just as happily against a proxy that refuses nothing. Every case below
// that matters is a rejection, and the accept cases are here to prove the refusals are not
// a blanket outage, which would be its own kind of broken.
//
// The classifier's value is in never silently dropping a failure it does not recognise.
// That is asserted directly, because a gate added later is exactly the input it will meet.

import { describe, it, expect, vi } from 'vitest'

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => makeFakeBuilder(table),
    rpc: () => { throw new Error('the real rpc must never be reached') },
    storage: {},
    auth: {},
  }),
}))

/**
 * A builder that RECORDS the chain and resolves to a fixed row.
 *
 * It honours nothing, and that is fine here because no test below asserts on filtering.
 * The thing under test is the proxy in front of it, so the fake only has to be reachable.
 */
function makeFakeBuilder(table: string) {
  const chain: Record<string, unknown> = {
    _table: table,
    then: (resolve: (v: unknown) => unknown) => resolve({ data: [{ id: 'row' }], error: null }),
  }
  for (const m of ['select', 'eq', 'in', 'not', 'order', 'limit', 'single', 'maybeSingle', 'gte']) {
    chain[m] = () => chain
  }
  // The write verbs EXIST on the fake on purpose. If the proxy ever stopped refusing them,
  // a fake lacking them would fail with "not a function" and the test would still be green
  // for the wrong reason: the write would have been blocked by the fake, not by the proxy.
  for (const m of ['insert', 'update', 'upsert', 'delete']) {
    chain[m] = () => { throw new Error(`the real ${m} must never be reached`) }
  }
  return chain
}

const { readOnlyClient, classifyGateFailure, usdForUsage, USD_PER_MTOK } =
  await import('../export-writer-run')

function client() {
  return readOnlyClient('https://example.invalid', 'service-key')
}

describe('readOnlyClient: refusals', () => {
  for (const verb of ['insert', 'update', 'upsert', 'delete'] as const) {
    it(`refuses .${verb}() on a query`, () => {
      const q = client().from('prospects') as unknown as Record<string, unknown>
      expect(() => q[verb]).toThrow(/read-only client/)
    })
  }

  it('refuses rpc, because a SECURITY DEFINER function is a write path that does not look like one', () => {
    const c = client() as unknown as Record<string, unknown>
    expect(() => c.rpc).toThrow(/read-only client/)
  })

  it('refuses storage, auth and any other client surface', () => {
    const c = client() as unknown as Record<string, unknown>
    expect(() => c.storage).toThrow(/read-only client/)
    expect(() => c.auth).toThrow(/read-only client/)
    expect(() => c.schema).toThrow(/read-only client/)
  })

  it('refuses a method it was never told about, rather than passing it through', () => {
    // The allowlist direction, asserted directly. A denylist of write verbs would let this
    // through, and the whole argument for the proxy is that it fails closed on the unknown.
    const q = client().from('prospects') as unknown as Record<string, unknown>
    expect(() => q.somethingAddedNextYear).toThrow(/read-only client/)
  })

  it('refuses the write verb even after a chain of legal reads', () => {
    const q = client().from('prospects').select('id').eq('id', 'x') as unknown as Record<string, unknown>
    expect(() => q.update).toThrow(/read-only client/)
  })
})

describe('readOnlyClient: reads still work', () => {
  it('allows a select chain to build and resolve', async () => {
    const { data, error } = await client()
      .from('prospects').select('id').eq('id', 'x').limit(1)
    expect(error).toBeNull()
    expect(data).toEqual([{ id: 'row' }])
  })

  it('allows the chain shapes the script actually uses', async () => {
    await expect(
      client().from('prospects').select('id').not('personalisation_question', 'is', null).order('id'),
    ).resolves.toBeDefined()
    await expect(
      client().from('prospect_research_results').select('id').gte('created_at', 'x').limit(5),
    ).resolves.toBeDefined()
  })
})

describe('classifyGateFailure', () => {
  // The literals below are copied from the gates that emit them in write-opening.ts. If a
  // gate's wording changes, this test is where that shows up, which is the point: a
  // classifier keyed on prose is only as good as its agreement with the prose.
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['the whole block is 74 words against a hard cap of 67 and a target of 58', 'length'],
    ['opening is 74 words, cap is 67', 'length'],
    ['opening names the prospect ("Sam"), which reads as third person', 'names_prospect'],
    ['claims not traceable to any finding: 2019', 'untraceable_claim'],
    ['opens a sentence with a name nothing in the findings supplied: Acme', 'sentence_initial_name'],
    ["quotes 500K from the prospect's record: qualify by role", 'firmographic'],
    ['contains 2 question marks: the closing question is the only question', 'question_marks'],
    ['repeats the approved offer line, which is already in the email', 'offer_line_echo'],
    ['contains a sentence with no verb in it: some fragment', 'no_finite_verb'],
    ['writer returned no closing question', 'missing_question'],
    ['writer returned no observation', 'missing_observation'],
    ['writer returned no bridge', 'missing_bridge'],
  ]

  for (const [failure, expected] of cases) {
    it(`classifies ${expected}`, () => {
      expect(classifyGateFailure(failure)).toBe(expected)
    })
  }

  it('sends an unrecognised failure to unclassified rather than dropping it', () => {
    // A gate added after this file was written produces exactly this. It must be counted
    // and surfaced, never swallowed into a neighbouring bucket or discarded.
    expect(classifyGateFailure('some gate that does not exist yet said no')).toBe('unclassified')
  })
})

describe('usdForUsage', () => {
  it('prices each token class at its own rate', () => {
    const usd = usdForUsage({
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
      calls: 4,
    })
    const expected =
      USD_PER_MTOK.input + USD_PER_MTOK.output + USD_PER_MTOK.cacheWrite + USD_PER_MTOK.cacheRead
    expect(usd).toBeCloseTo(expected, 10)
  })

  it('charges a cache read a tenth of an uncached input token', () => {
    // The cache multipliers are the half of this most easily got backwards, and getting
    // them backwards moves the per-prospect figure by more than the whole cost question.
    const read = usdForUsage({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 1_000_000, calls: 1 })
    const uncached = usdForUsage({ input_tokens: 1_000_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, calls: 1 })
    expect(read * 10).toBeCloseTo(uncached, 10)
  })

  it('is zero for a run that made no calls', () => {
    expect(usdForUsage({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, calls: 0 })).toBe(0)
  })
})
