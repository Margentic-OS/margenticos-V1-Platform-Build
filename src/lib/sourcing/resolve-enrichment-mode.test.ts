// Tests for resolveEnrichmentMode.
//
// The bug being guarded: the enrichment banner's error branch and its safe branch were
// the same branch. A failed read rendered "Test Mode Active", identical to a successful
// read of a disabled flag, so a banner that could not read anything looked like good
// news. Measured 2026-09-01, the flag was live while the banner said test mode.
//
// The point of every test below is that a FAILURE MUST NOT LOOK LIKE 'test'.
//
// The fake honours the filters it is given and THROWS on any method it does not
// implement, rather than returning itself. A fake that silently accepts an unimplemented
// call cannot test the thing it was written to test: that is how the existing
// enrichment-mode.test.ts ends up exercising only its catch block, because its chain
// stops at .is() while the code under test calls .single().

import { describe, it, expect, vi } from 'vitest'
import { resolveEnrichmentMode } from './enrichment-mode'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

type FakeOpts = {
  row?: unknown
  error?: { message: string } | null
  throwFromFrom?: boolean
}

function makeRegistryFake(opts: FakeOpts) {
  const calls = { table: '' as string, columns: '' as string, filters: [] as Array<[string, unknown]> }

  const chain: Record<string, unknown> = {
    select: (cols: string) => {
      calls.columns = cols
      return chain
    },
    eq: (col: string, val: unknown) => {
      calls.filters.push([col, val])
      return chain
    },
    // Honoured by throwing. If anyone reintroduces the archived_at filter, or any other
    // filter this query has no business applying, the call fails loudly instead of being
    // swallowed into `chain`.
    is: (col: string) => {
      throw new Error(`fake: .is('${col}') is not implemented — integrations_registry has no such column`)
    },
    single: () => {
      throw new Error('fake: .single() is not implemented — resolveEnrichmentMode must use maybeSingle()')
    },
    limit: () => {
      throw new Error('fake: .limit() is not implemented')
    },
    maybeSingle: async () => ({
      data: opts.error ? null : (opts.row ?? null),
      error: opts.error ?? null,
    }),
  }

  const client = {
    from: (table: string) => {
      if (opts.throwFromFrom) throw new Error('Network error')
      calls.table = table
      return chain
    },
  }

  return { client: client as never, calls }
}

describe('resolveEnrichmentMode', () => {
  it("returns 'live' when enrichment_live is true", async () => {
    const { client } = makeRegistryFake({ row: { config: { enrichment_live: true } } })
    expect(await resolveEnrichmentMode(client)).toBe('live')
  })

  it("returns 'test' when enrichment_live is false", async () => {
    const { client } = makeRegistryFake({ row: { config: { enrichment_live: false } } })
    expect(await resolveEnrichmentMode(client)).toBe('test')
  })

  it("returns 'test' when the flag is absent from config", async () => {
    const { client } = makeRegistryFake({ row: { config: {} } })
    expect(await resolveEnrichmentMode(client)).toBe('test')
  })

  // ── The three failure cases. None of them may return 'test'. ───────────────

  it("returns 'unknown', NOT 'test', when the query errors", async () => {
    const { client } = makeRegistryFake({ error: { message: 'permission denied' } })
    const mode = await resolveEnrichmentMode(client)
    expect(mode).toBe('unknown')
    expect(mode).not.toBe('test')
  })

  it("returns 'unknown', NOT 'test', when the row is missing", async () => {
    const { client } = makeRegistryFake({ row: null })
    const mode = await resolveEnrichmentMode(client)
    expect(mode).toBe('unknown')
    expect(mode).not.toBe('test')
  })

  it("returns 'unknown', NOT 'test', when the client throws", async () => {
    const { client } = makeRegistryFake({ throwFromFrom: true })
    const mode = await resolveEnrichmentMode(client)
    expect(mode).toBe('unknown')
    expect(mode).not.toBe('test')
  })

  // ── The query shape itself. This is the original defect. ──────────────────

  it('queries integrations_registry filtering on capability and nothing else', async () => {
    const { client, calls } = makeRegistryFake({ row: { config: { enrichment_live: true } } })
    await resolveEnrichmentMode(client)

    expect(calls.table).toBe('integrations_registry')
    expect(calls.columns).toBe('config')
    // Exactly one filter. archived_at does not exist on this table and filtering on it
    // returned 42703 on every request for the life of the previous banner.
    expect(calls.filters).toEqual([['capability', 'can_enrich_contact']])
    expect(calls.filters.map(([col]) => col)).not.toContain('archived_at')
  })

  it('reads the same flag name that gates real Apollo spend', async () => {
    // shouldUseMockEnrichment keys on config.enrichment_live. If the banner ever keys on
    // a different name it will report a flag nobody sets, which is drift by another route.
    const { client } = makeRegistryFake({ row: { config: { enrichment_live: true, some_other_flag: false } } })
    expect(await resolveEnrichmentMode(client)).toBe('live')
  })
})
