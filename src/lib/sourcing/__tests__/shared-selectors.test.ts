// THE TWO FILTERS THAT NOW HAVE ONE DEFINITION EACH.
//
// Both were written inline in the code that ACTS, and a screen that wanted to count the same
// rows had no way to do it except by writing the condition a second time. That is the
// parallel-lists shape from CLAUDE.md, and this codebase has already paid for it: removed_count
// and removed_by_reason are two computations of one number, and a conjunct dropped in one was
// left in the other.
//
// These assert the EXACT filters applied, so a future edit to either selector shows up as a
// failing expectation rather than as a screen quietly disagreeing with behaviour.
//
// THE FAKE THROWS ON ANYTHING IT DOES NOT IMPLEMENT. A chainable stub that silently returns
// itself for an unknown method is the shape CLAUDE.md records three instances of: the test
// passes in both worlds and the guard it claims to cover is not covered.
//
// Run:
//   npx dotenv -e .env.test.local -- npx vitest run src/lib/sourcing/__tests__/shared-selectors.test.ts

import { describe, it, expect } from 'vitest'
import { selectPendingVerification } from '../pending-verification'
import { selectUnpublished } from '../publishable'

type Call = { method: string; args: unknown[] }

/**
 * A query stub that RECORDS what was applied and THROWS on anything it does not implement.
 *
 * The throw is the whole point. A chainable stub that silently returns itself for an unknown
 * method makes a test pass whether or not the filter under test is applied, which is the
 * fake-that-does-not-honour-a-filter shape CLAUDE.md records three instances of.
 */
function recordingQuery(methods: string[]) {
  const calls: Call[] = []
  const impl: Record<string, unknown> = {}
  for (const method of methods) {
    impl[method] = (...args: unknown[]) => {
      calls.push({ method, args })
      return proxy
    }
  }
  const proxy = new Proxy(impl, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      throw new Error(
        `the recording fake does not implement .${prop}(). Returning the chain silently ` +
        'would make this test pass whether or not the filter is applied.',
      )
    },
  })
  return { proxy: proxy as never, calls }
}

function applied(calls: Call[]) {
  return calls.map(c => `${c.method}(${c.args.map(a => JSON.stringify(a)).join(',')})`)
}

describe('selectPendingVerification', () => {
  const thresholds = {
    staleThresholdISO: '2026-09-17T14:00:00Z',
    staleLockThresholdISO: '2026-09-17T19:30:00Z',
    maxRetryAttempts: 3,
  }

  function capture() {
    const { proxy, calls } = recordingQuery(['eq', 'is', 'or', 'lt', 'not', 'in', 'limit'])
    selectPendingVerification(proxy, thresholds)
    return applied(calls)
  }

  it('requires the prospect to be enriched', () => {
    expect(capture()).toContain('eq("enrichment_status","enriched")')
  })

  // The two .or() groups, byte for byte as verifyEnrichedBatch applied them before the
  // extraction. Changing either changes which addresses get probed and what the daily quota
  // is spent on.
  it('selects never-verified rows and retryable grey-listed ones', () => {
    expect(capture()).toContain(
      'or("independent_email_status.is.null,and(independent_email_status.eq.Grey-listed,independent_verified_at.lt.2026-09-17T14:00:00Z)")',
    )
  })

  it('reclaims a lock that has gone stale, and only then', () => {
    expect(capture()).toContain(
      'or("verification_locked_at.is.null,verification_locked_at.lt.2026-09-17T19:30:00Z")',
    )
  })

  // THE RETRY CAP GOVERNS BOTH BRANCHES because it is its own chained filter rather than
  // living inside one arm of the .or(). Losing it makes a row that fails on a provider
  // error retry forever.
  it('applies the retry cap as its own filter', () => {
    expect(capture()).toContain('lt("verification_attempt_count",3)')
  })

  it('excludes prospects tiering rejected, and does not require a tier', () => {
    const calls = capture()
    // excludeTierRejected's own shape. requireTierPresent would be a different filter and
    // would starve verification while it waits for tiering; ADR-060 records why the two
    // paths differ.
    expect(calls.some(c => c.includes('tiering_reason'))).toBe(true)
    expect(calls.some(c => c.includes('sourced_tier') && c.startsWith('not('))).toBe(false)
  })
})

describe('selectUnpublished', () => {
  function capture() {
    const { proxy, calls } = recordingQuery(['eq', 'is', 'not', 'select'])
    selectUnpublished(proxy)
    return applied(calls)
  }

  it('selects only rows never published', () => {
    expect(capture()).toContain('is("tier_published_at",null)')
  })

  // Part of the definition, not an extra: a suppressed prospect is never published, so
  // counting one would promise work the update will not do.
  it('excludes suppressed prospects', () => {
    expect(capture()).toContain('eq("suppressed",false)')
  })

  it('applies exactly those two filters and nothing else', () => {
    expect(capture()).toHaveLength(2)
  })
})
