// THE TWO PIPELINE NUMBERS THAT BOTH CLAIM TO MEAN "CAN BE EMAILED".
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS
//
// On 2026-09-08 three prospects on production read "Can be emailed: Yes" while suppressed:
// two had replied `stop` in August, one had been stopped by an operator that morning. All
// three were inside the counts an operator plans campaign volume from.
//
// The reason it reached three separate numbers is that "can be emailed" had three separate
// definitions, and only one of them was obviously a definition:
//
//   1. whyNotSendable                 the quality-check screen's column and tier headers
//   2. TierMetrics.sendable           the pipeline overview, re-polled every 30 seconds
//   3. BatchFunnel.eligible           a funnel stage LABELLED "Can be emailed", which read
//                                     the column directly and did not go near the helper
//
// The third is the one that makes this file necessary rather than tidy. Fixing the helper
// alone fixes 1 and 2, leaves 3 wrong, and looks finished. Both counts are asserted here
// against the same rows so they cannot answer differently again.
//
// Run:
//   npx dotenv -e .env.test.local -- npx vitest run src/lib/operator/__tests__/sendability-counts.test.ts

import { describe, it, expect } from 'vitest'
import {
  countRow,
  emptyFunnel,
  STATUS_COLUMNS,
  type StatusRow,
} from '../sourcing-metrics'

/** A tier-1 prospect the send gate would happily send to. */
function sendableRow(overrides: Partial<StatusRow> = {}): StatusRow {
  return {
    sourcing_run_id: 'run-1',
    sourcing_review_status: 'approved',
    suppressed: false,
    research_ran_at: null,
    personalisation_trigger: null,
    sourced_tier: 'tier_1',
    tiering_reason: 'tier_1 (score 100): industry 45, seniority 35, headcount 20',
    enrichment_status: 'enriched',
    email_send_eligible: true,
    email_send_ineligible_reason: null,
    independent_verified_at: '2026-09-01T00:00:00Z',
    independent_email_status: 'Valid',
    verification_provider: 'myemailverifier',
    second_pass_status: null,
    second_pass_provider: null,
    last_verification_error: null,
    verification_attempt_count: 1,
    ...overrides,
  }
}

function count(rows: StatusRow[]) {
  const funnel = emptyFunnel('run-1')
  for (const row of rows) countRow(funnel, row)
  return funnel
}

describe('the pipeline counts exclude a prospect nobody may contact', () => {
  it('counts an ordinary sendable prospect in both numbers', () => {
    // The control. Without it, a guard that excluded EVERYONE would pass every test below,
    // and an outage reads exactly like a fix.
    const f = count([sendableRow()])
    expect(f.tiers.tier_1.sendable).toBe(1)
    expect(f.eligible).toBe(1)
  })

  it('keeps a suppressed prospect out of TierMetrics.sendable, the pipeline overview number', () => {
    // Screen 2. Server-rendered AND re-polled every 30 seconds, so a wrong value here does
    // not decay: it is re-fetched and re-displayed, which makes it read as freshly confirmed.
    const f = count([sendableRow({ suppressed: true })])
    expect(f.tiers.tier_1.total).toBe(1)
    expect(f.tiers.tier_1.sendable).toBe(0)
  })

  it('keeps a suppressed prospect out of BatchFunnel.eligible, the stage labelled "Can be emailed"', () => {
    // Screen 3, and the one that reads the column directly rather than through the helper.
    // This assertion is what stops a future fix to whyNotSendable from looking complete
    // while this stage quietly keeps its own, older answer.
    const f = count([sendableRow({ suppressed: true })])
    expect(f.verified).toBe(1)
    expect(f.eligible).toBe(0)
  })

  it('gives the reason rather than dropping the prospect from the breakdown', () => {
    // The row must still be visible as a tier member with a stated reason. Subtracting it
    // from `sendable` while listing it under nothing would replace one wrong number with a
    // count that does not add up, and an operator cannot tell those apart.
    const f = count([sendableRow({ suppressed: true })])
    expect(f.tiers.tier_1.notSendableByReason.suppressed).toBe(1)
    expect(
      f.tiers.tier_1.sendable +
        Object.values(f.tiers.tier_1.notSendableByReason).reduce((a, b) => a + b, 0),
    ).toBe(f.tiers.tier_1.total)
  })

  it('agrees with itself across a mixed batch', () => {
    // The production shape on 2026-09-08: mostly sendable, a couple suppressed, one blocked
    // by its verification verdict. The two numbers must not diverge from each other.
    const f = count([
      sendableRow(),
      sendableRow(),
      sendableRow({ suppressed: true }),                              // replied stop
      sendableRow({ suppressed: true, sourced_tier: 'tier_3' }),      // operator stop
      sendableRow({ email_send_eligible: false, independent_email_status: 'Invalid' }),
    ])
    expect(f.eligible).toBe(2)
    expect(f.tiers.tier_1.sendable + f.tiers.tier_3.sendable).toBe(2)
    expect(f.tiers.tier_3.notSendableByReason.suppressed).toBe(1)
  })
})

describe('the select list asks for every column the counting reads', () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // A GUARD THAT CANNOT DRIFT, because a select list is a string and nothing type-checks it.
  //
  // If `suppressed` ever falls out of STATUS_COLUMNS the code still compiles, the field
  // arrives undefined, `=== true` is false, and every suppressed prospect counts as sendable
  // again in silence. That is the same family as a test fake that swallows .select(): the
  // check runs and cannot reach the thing it is checking.
  //
  // So rather than listing the columns by hand (a second list to keep in step, which is the
  // shape this codebase keeps getting bitten by), countRow is walked with a recording Proxy
  // and asked what it actually touched.

  function columnsTouchedBy(rows: StatusRow[]): Set<string> {
    const touched = new Set<string>()
    const funnel = emptyFunnel('run-1')
    for (const row of rows) {
      countRow(
        funnel,
        new Proxy(row, {
          get(target, key: string) {
            touched.add(key)
            return target[key as keyof StatusRow]
          },
        }) as StatusRow,
      )
    }
    return touched
  }

  // Enough variety to walk every branch: tiered, removed, suppressed, unverified, failed.
  const REPRESENTATIVE: StatusRow[] = [
    sendableRow(),
    sendableRow({ suppressed: true }),
    sendableRow({ email_send_eligible: false, email_send_ineligible_reason: 'country_excluded_de' }),
    sendableRow({ sourced_tier: null, tiering_reason: 'company_too_large' }),
    sendableRow({ independent_verified_at: null, email_send_eligible: false }),
    sendableRow({ last_verification_error: 'Email verification failed: API returned 429' }),
    sendableRow({ research_ran_at: '2026-09-02T00:00:00Z', personalisation_trigger: 'a line' }),
  ]

  it('proves the recorder can see a column before trusting what it does not see', () => {
    // The instrument check. A Proxy that recorded nothing would make every assertion below
    // pass vacuously, which is precisely how a broken check reports success.
    const touched = columnsTouchedBy(REPRESENTATIVE)
    expect(touched.size).toBeGreaterThan(5)
    expect(touched.has('suppressed')).toBe(true)
    expect(touched.has('email_send_eligible')).toBe(true)
  })

  it('names every column the counting touches', () => {
    const selected = new Set(STATUS_COLUMNS.split(',').map(c => c.trim()))
    const missing = [...columnsTouchedBy(REPRESENTATIVE)].filter(c => !selected.has(c))
    expect(missing).toEqual([])
  })

  it('names suppressed explicitly, because losing it fails open rather than loudly', () => {
    expect(STATUS_COLUMNS.split(',').map(c => c.trim())).toContain('suppressed')
  })
})
