// THE FAKE'S OWN TESTS. Read this before trusting any test that uses the fake.
//
// CLAUDE.md names three fakes in this repository that shipped green while silently ignoring
// a filter: a swallowed .limit(), a swallowed .select(cols), and dropped job_type/state
// filters. In all three the production code was correct and the test could not have noticed
// if it stopped being.
//
// So the fake is not trusted on the strength of its source. Each filter below is proved by
// running the SAME rows through a query with and without it and showing the answers differ.
// A filter that changes nothing is a filter that is being swallowed, and each test here
// fails if that is what the fake is doing.

import { describe, it, expect } from 'vitest'
import { fakeProspectsClient, evaluateOrFilter } from './fake-prospects-client'
import { TIER_NOT_REJECTED_FILTER } from '@/lib/sourcing/tier-verdict'

const ORGS = { 'org-live': { archived_at: null }, 'org-archived': { archived_at: '2026-01-01' } }

/** A rejected row and a qualified row, which every or() test below separates. */
const TWO_ROWS = [
  { id: 'rejected', organisation_id: 'org-live', sourced_tier: null, tiering_reason: 'any-reason' },
  { id: 'qualified', organisation_id: 'org-live', sourced_tier: 'tier_1', tiering_reason: 'tier_1 (score 90)' },
]

describe('the fake honours .or(), and returns a DIFFERENT answer without it', () => {
  it('without the tier filter, both rows come back', async () => {
    const { client } = fakeProspectsClient(structuredClone(TWO_ROWS), { organisations: ORGS })
    const { data } = await (client as never as Record<string, (t: string) => Record<string, unknown>>)
      .from('prospects')
    // Deliberately no .or(). This is the "wrong answer" case: if the fake swallowed .or(),
    // the test below would produce this same result and prove nothing.
    const rows = (data ?? []) as Array<{ id: string }>
    expect(rows.map(r => r.id)).toEqual(['rejected', 'qualified'])
  })

  it('WITH the tier filter, the rejected row is gone', async () => {
    const { client } = fakeProspectsClient(structuredClone(TWO_ROWS), { organisations: ORGS })
    const query = (client as never as { from(t: string): Record<string, (...a: never[]) => unknown> })
      .from('prospects')
    const { data } = await (query.or as (e: string) => PromiseLike<{ data: Array<{ id: string }> }>)(
      TIER_NOT_REJECTED_FILTER,
    )
    expect(data.map(r => r.id)).toEqual(['qualified'])
  })

  it('parses the and() group the first-pass status branch actually uses', () => {
    const expr = 'independent_email_status.is.null,and(independent_email_status.eq.Grey-listed,independent_verified_at.lt.2026-09-01)'
    expect(evaluateOrFilter(expr, { independent_email_status: null })).toBe(true)
    expect(evaluateOrFilter(expr, { independent_email_status: 'Valid' })).toBe(false)
    // Grey-listed and stale: retryable.
    expect(evaluateOrFilter(expr, {
      independent_email_status: 'Grey-listed', independent_verified_at: '2026-08-01',
    })).toBe(true)
    // Grey-listed but verified too recently: not retryable.
    expect(evaluateOrFilter(expr, {
      independent_email_status: 'Grey-listed', independent_verified_at: '2026-09-02',
    })).toBe(false)
  })

  it('the tier filter reads the PRESENCE of a reason, never its value', () => {
    // Rule zero. A reason string nothing in the codebase lists still rejects the row.
    expect(evaluateOrFilter(TIER_NOT_REJECTED_FILTER, {
      sourced_tier: null, tiering_reason: 'a-legacy-value-no-module-knows',
    })).toBe(false)
    // Not yet tiered: both null. Passes, because only a REJECTION stops a prospect.
    expect(evaluateOrFilter(TIER_NOT_REJECTED_FILTER, { sourced_tier: null, tiering_reason: null })).toBe(true)
  })
})

describe('the fake honours .limit(), and returns a DIFFERENT answer without it', () => {
  const FIVE = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, organisation_id: 'org-live' }))

  it('without .limit(), all five come back', async () => {
    const { client } = fakeProspectsClient(structuredClone(FIVE), { organisations: ORGS })
    const { data } = await (client as never as { from(t: string): PromiseLike<{ data: unknown[] }> })
      .from('prospects')
    expect(data).toHaveLength(5)
  })

  it('WITH .limit(2), exactly two come back', async () => {
    const { client } = fakeProspectsClient(structuredClone(FIVE), { organisations: ORGS })
    const query = (client as never as { from(t: string): { limit(n: number): PromiseLike<{ data: unknown[] }> } })
      .from('prospects')
    const { data } = await query.limit(2)
    // This is the assertion the three shipped-green fakes could not make. A swallowed
    // .limit() returns 5 here and the whole batch-size guard becomes untestable.
    expect(data).toHaveLength(2)
  })
})

describe('the fake honours the !inner join, and returns a DIFFERENT answer without it', () => {
  const MIXED = [
    { id: 'in-live-org', organisation_id: 'org-live' },
    { id: 'in-archived-org', organisation_id: 'org-archived' },
  ]

  it('without the join filter, the archived organisation\'s row comes back', async () => {
    const { client } = fakeProspectsClient(structuredClone(MIXED), { organisations: ORGS })
    const query = (client as never as { from(t: string): { select(c: string): PromiseLike<{ data: Array<{ id: string }> }> } })
      .from('prospects')
    const { data } = await query.select('id, organisation_id')
    expect(data.map(r => r.id)).toEqual(['in-live-org', 'in-archived-org'])
  })

  it('WITH the join filter, only the live organisation\'s row survives', async () => {
    const { client } = fakeProspectsClient(structuredClone(MIXED), { organisations: ORGS })
    const query = (client as never as {
      from(t: string): { select(c: string): { is(col: string, v: null): PromiseLike<{ data: Array<{ id: string }> }> } }
    }).from('prospects')
    const { data } = await query
      .select('id, organisation_id, organisations!inner(archived_at)')
      .is('organisations.archived_at', null)
    expect(data.map(r => r.id)).toEqual(['in-live-org'])
  })

  it('a row whose organisation does not exist is dropped, which is !inner semantics', async () => {
    const { client } = fakeProspectsClient(
      [{ id: 'orphan', organisation_id: 'org-that-does-not-exist' }],
      { organisations: ORGS },
    )
    const query = (client as never as {
      from(t: string): { select(c: string): PromiseLike<{ data: unknown[] }> }
    }).from('prospects')
    const { data } = await query.select('id, organisations!inner(archived_at)')
    expect(data).toHaveLength(0)
  })
})

describe('the fake THROWS rather than silently passing on what it does not implement', () => {
  // The rule from CLAUDE.md: "limit: () => { throw ... } is a better fake than one that
  // ignores it." Silently returning the chain is the failure mode, so these must be errors.
  it('rejects a join filter naming a resource the select never joined', async () => {
    const { client } = fakeProspectsClient([{ id: 'p1', organisation_id: 'org-live' }], { organisations: ORGS })
    const query = (client as never as {
      from(t: string): { select(c: string): { is(col: string, v: null): PromiseLike<unknown> } }
    }).from('prospects')
    // No !inner in the select, so this filter would do nothing at all in a lenient fake.
    await expect(query.select('id').is('organisations.archived_at', null)).rejects.toThrow(
      /never joined "organisations"/,
    )
  })

  it('rejects an or() operator it cannot evaluate', () => {
    expect(() => evaluateOrFilter('some_column.like.%thing%', { some_column: 'thing' })).toThrow(
      /not implemented/,
    )
  })

  // This one throws at CALL time rather than at await time, because .not() can tell it is
  // unsupported without seeing a row. The join filter above cannot: it only discovers the
  // missing join when it resolves a column, which happens in then(). Both are errors; the
  // difference is only when, and the tests say which is which rather than papering over it.
  it('rejects .not() in a form it does not implement', () => {
    const { client } = fakeProspectsClient([{ id: 'p1', organisation_id: 'org-live' }], { organisations: ORGS })
    const query = (client as never as {
      from(t: string): { not(c: string, op: string, v: unknown): unknown }
    }).from('prospects')
    expect(() => query.not('email', 'eq', 'x@y.com')).toThrow(/not implemented/)
  })
})
