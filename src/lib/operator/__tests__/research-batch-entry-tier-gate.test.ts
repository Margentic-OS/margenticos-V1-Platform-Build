// The tier gate on the INLINE research path.
//
// This path and the queue path (src/lib/queue/enqueue/research.ts) must refuse exactly the
// same prospects. That standing rule is stated in the queue path's own header: while both
// exist behind a flag, a prospect must be eligible under ONE definition, or flipping
// queue_research changes WHICH prospects get researched rather than only how. So the tier
// gate went into both in the same commit, from the same module, and both are tested.
//
// WHY THE ASSERTION IS ON THE REFUSAL MESSAGE.
//
// selectProspects is private, and running past it reaches the agent batch. The two
// refusal messages are what distinguishes the gated world from the ungated one:
//
//   gate present -> the rejected row never enters the population -> "Nothing to research"
//   gate absent  -> it enters, it holds copy, the trigger guard refuses the whole batch
//
// That mirrors the live data exactly: 9 of the rejected rows in the live organisation hold
// finished personalisation copy.

import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { runResearchBatchForOrg } from '../research-batch-entry'

/**
 * A rejection reason, deliberately NOT one of the real ones.
 *
 * The gate is on the PRESENCE of a reason, never on what it says, and a fixture carrying a
 * real reason string would read as though the value mattered. It also would not catch the
 * legacy value already in the live data that REMOVAL_REASONS no longer lists.
 */
const A_REJECTION = 'a-rejection-reason-the-gate-never-reads'


vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

const ORG = 'org-inline'

interface FakeProspect {
  id: string
  personalisation_trigger: string | null
  sourced_tier?: string | null
  tiering_reason?: string | null
}

/**
 * The tier gate RESEARCH applies, as the database applies it:
 *   sourced_tier IS NOT NULL
 *
 * CHANGED 2026-09-15 from the looser `sourced_tier IS NOT NULL OR tiering_reason IS NULL`,
 * in the same commit as enqueue/research.ts. The two research entry points must always agree,
 * or the CLI and the queue research different sets.
 *
 * Keyed off `undefined` rather than `??`, because a fixture that explicitly sets
 * sourced_tier to null is the row under test.
 */
function hasPositiveTier(p: FakeProspect): boolean {
  const tier = p.sourced_tier === undefined ? 'tier_1' : p.sourced_tier
  return tier !== null
}

function fake(prospects: FakeProspect[]) {
  const client = {
    from(table: string) {
      if (table === 'organisations') {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          is: () => chain,
          single: async () => ({ data: { id: ORG, name: 'Inline' }, error: null }),
        }
        return chain
      }
      if (table !== 'prospects') throw new Error(`fake does not implement table ${table}`)

      const orFilters: string[] = []
      const notFilters: Array<[string, string, unknown]> = []
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        // HONOURED, not swallowed, AND IT USED TO BE SWALLOWED.
        //
        // This read `not: () => chain`, which accepted the call and ignored it. That was
        // harmless while the gate used .or(), and became the exact hazard CLAUDE.md names as
        // soon as the gate moved to requireTierPresent on 2026-09-15: the filter would have
        // been dropped silently, both tests below would have passed, and deleting the gate
        // from the real query would have broken nothing. A fake that does not honour a filter
        // cannot test that filter.
        not: (c: string, op: string, v: unknown) => { notFilters.push([c, op, v]); return chain },
        in: () => chain,
        // Kept honoured too. Nothing here uses it now, but a fake that starts swallowing a
        // method the day its last caller leaves is a trap set for the next caller.
        or: (expr: string) => { orFilters.push(expr); return chain },
        then: (resolve: (v: unknown) => void) => {
          const tierGated = notFilters.some(
            ([c, op, v]) => c === 'sourced_tier' && op === 'is' && v === null,
          )
          const rows = prospects
            .filter(p => !tierGated || hasPositiveTier(p))
            .map(p => ({
              id: p.id,
              personalisation_trigger: p.personalisation_trigger,
              // A clean verdict, so the send-eligibility gate is not what excludes the row.
              independent_verified_at: '2026-08-10T00:00:00Z',
              independent_email_status: 'Valid',
              email_send_ineligible_reason: null,
              verification_provider: 'myemailverifier',
              second_pass_status: null,
              second_pass_provider: null,
            }))
          resolve({ data: rows, error: null })
        },
      }
      return chain
    },
  }
  return client as unknown as SupabaseClient
}

describe('runResearchBatchForOrg — the tier gate', () => {
  it('a rejected prospect holding shipped copy is not in the population at all', async () => {
    const result = await runResearchBatchForOrg({
      supabase: fake([{
        id: 'rejected',
        personalisation_trigger: 'An opening that already shipped.',
        sourced_tier: null,
        tiering_reason: A_REJECTION,
      }]),
      organisation_id: ORG,
      scope: 'unresearched',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected refusal')
    expect(result.error).toMatch(/Nothing to research/)
    // Remove the gate from the real query and this is the message instead, because the
    // rejected row enters the batch and its copy trips the trigger guard.
    expect(result.error).not.toMatch(/personalisation trigger/)
  })

  it('REFUSES a prospect tiering has not reached yet, so no research is bought on a guess', async () => {
    // INVERTED 2026-09-15, and the old expectation was the defect. requireTierPresent, not
    // excludeTierRejected: an ICP revision clears tiering_reason, which turns a rejected row
    // into this one until the next tiering run, and research costs about $0.21 a prospect.
    // Measured 2026-09-14: $0.42 spent on two prospects tiering rejected two hours later.
    const result = await runResearchBatchForOrg({
      supabase: fake([{
        id: 'pending',
        personalisation_trigger: 'An opening that already shipped.',
        sourced_tier: null,
        tiering_reason: null,
      }]),
      organisation_id: ORG,
      scope: 'unresearched',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected refusal')
    // 'Nothing to research', not the trigger guard. The row never enters the population now,
    // so its shipped copy is never even consulted. Before this change the message WAS the
    // trigger-guard one, which is what that assertion used to read.
    expect(result.error).toMatch(/Nothing to research/)
    expect(result.error).not.toMatch(/personalisation trigger/)
  })

  it('still selects a prospect that HAS a positive tier', async () => {
    // THE CONTROL. Both refusals above would also be produced by a gate that admits nobody,
    // and a gate that admits nobody is an outage rather than a saving.
    const result = await runResearchBatchForOrg({
      supabase: fake([{
        id: 'tiered',
        personalisation_trigger: 'An opening that already shipped.',
        sourced_tier: 'tier_1',
        tiering_reason: null,
      }]),
      organisation_id: ORG,
      scope: 'unresearched',
    })

    // It reaches the trigger guard, which is what proves it was admitted to the population.
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected the trigger guard to refuse it')
    expect(result.error).toMatch(/personalisation trigger/)
  })
})
