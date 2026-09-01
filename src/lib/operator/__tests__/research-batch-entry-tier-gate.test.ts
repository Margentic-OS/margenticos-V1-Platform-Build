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
import { TIER_NOT_REJECTED_FILTER } from '@/lib/sourcing/tier-verdict'

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
 * The tier gate as the database applies it:
 *   sourced_tier IS NOT NULL OR tiering_reason IS NULL
 *
 * Keyed off `undefined` rather than `??`, because a fixture that explicitly sets
 * sourced_tier to null is the rejected row under test.
 */
function notRejected(p: FakeProspect): boolean {
  const tier = p.sourced_tier === undefined ? 'tier_1' : p.sourced_tier
  const reason = p.tiering_reason === undefined ? null : p.tiering_reason
  return tier !== null || reason === null
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
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        not: () => chain,
        in: () => chain,
        // HONOURED, not swallowed. Without this the gate would throw rather than be
        // ignored, and a fake that returned `chain` here could not test the filter at all.
        or: (expr: string) => { orFilters.push(expr); return chain },
        then: (resolve: (v: unknown) => void) => {
          const tierGated = orFilters.includes(TIER_NOT_REJECTED_FILTER)
          const rows = prospects
            .filter(p => !tierGated || notRejected(p))
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

  it('still selects a prospect tiering has not reached yet', async () => {
    // excludeTierRejected, not requireTierPresent. A pending prospect holding copy reaches
    // the trigger guard, which is the correct behaviour for a prospect still in play.
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
    expect(result.error).toMatch(/personalisation trigger/)
  })
})
