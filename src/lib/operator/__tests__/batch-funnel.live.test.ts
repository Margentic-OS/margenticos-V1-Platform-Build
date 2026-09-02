// THE RECONCILIATION, ASSERTED RATHER THAN HOPED FOR.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT THIS PROTECTS
//
// The pipeline screen shows an organisation-wide card and, underneath it, one line per
// sourcing run. The card must be the run lines added together plus whatever belongs to no
// run. If those two ever stop agreeing, the screen is back to the defect this whole change
// exists to remove: a number whose scope the reader cannot tell.
//
// The structural guarantee is that both come from countRow, walked over the same rows from
// the same read. This test is the behavioural proof of that, against a REAL database, and
// it is what goes red if somebody later "optimises" the batch counts into a second query.
//
// ALSO ASSERTED: a run whose prospects no longer exist still gets a line. That case is real
// on production, where three runs recorded 25 written each and have nothing present, and it
// is invisible to any run list built by grouping prospects.
//
// Run:
//   npx dotenv -e .env.test.local -- npx vitest run src/lib/operator/__tests__/batch-funnel.live.test.ts

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { createTestServiceClient } from '@/test-utils/test-database'
import { getMetricsForOrganisations, type PipelineMetrics } from '@/lib/operator/sourcing-metrics'

const STAMP = Date.now()
const ORG_NAME = `Batch Funnel Test ${STAMP}`

let supabase: SupabaseClient<Database>
let orgId: string
let runWithProspects: string
let runWithProspectsB: string
let runWhoseRowsAreGone: string
const prospectIds: string[] = []

async function seedRun(startedAt: string, written: number): Promise<string> {
  const { data, error } = await supabase
    .from('sourcing_runs')
    .insert({
      organisation_id: orgId,
      started_at: startedAt,
      completed_at: startedAt,
      status: 'completed',
      target_batch_size: 25,
      candidates_returned: 25,
      prospects_written: written,
      trigger_type: 'operator_manual',
    } as never)
    .select('id')
    .single()
  if (error || !data) throw new Error(`seed run failed: ${error?.message}`)
  return (data as { id: string }).id
}

async function seedProspect(fields: Record<string, unknown>): Promise<string> {
  const { data, error } = await supabase
    .from('prospects')
    .insert({ organisation_id: orgId, ...fields } as never)
    .select('id')
    .single()
  if (error || !data) throw new Error(`seed prospect failed: ${error?.message}`)
  const id = (data as { id: string }).id
  prospectIds.push(id)
  return id
}

/** A prospect that survived tiering into tier 1. */
const tier1 = { sourcing_review_status: 'approved', enrichment_status: 'enriched', sourced_tier: 'tier_1' }
/** A prospect tiering removed. sourced_tier NULL with a reason is the discriminator. */
const removed = { sourcing_review_status: 'approved', enrichment_status: 'enriched', tiering_reason: 'headcount_out_of_range' }

beforeAll(async () => {
  supabase = createTestServiceClient('batch-funnel.live.test.ts')

  const { data: org, error } = await supabase
    .from('organisations')
    .insert({ name: ORG_NAME, slug: `batch-funnel-test-${STAMP}`, founder_first_name: 'Test' } as never)
    .select('id')
    .single()
  if (error || !org) throw new Error(`could not create the test organisation: ${error?.message}`)
  orgId = (org as { id: string }).id

  // Two runs a minute apart, which is the case timestamp clustering could not separate.
  runWithProspects  = await seedRun('2026-01-01T10:00:00Z', 3)
  runWithProspectsB = await seedRun('2026-01-01T10:01:00Z', 2)
  // A run that wrote prospects which no longer exist.
  runWhoseRowsAreGone = await seedRun('2026-01-01T10:02:00Z', 25)

  await seedProspect({ ...tier1,   sourcing_run_id: runWithProspects })
  await seedProspect({ ...tier1,   sourcing_run_id: runWithProspects })
  await seedProspect({ ...removed, sourcing_run_id: runWithProspects })
  await seedProspect({ ...tier1,   sourcing_run_id: runWithProspectsB })
  await seedProspect({ ...tier1,   sourcing_run_id: runWithProspectsB })
  // Belongs to no run at all. Must be counted and must be visible.
  await seedProspect({ ...tier1 })
}, 60_000)

afterAll(async () => {
  // Prospects first: the foreign key is ON DELETE RESTRICT, so a run cannot be removed
  // while anything points at it. That ordering is itself the constraint working.
  if (prospectIds.length > 0) await supabase.from('prospects').delete().in('id', prospectIds)
  if (orgId) {
    await supabase.from('sourcing_runs').delete().eq('organisation_id', orgId)
    await supabase.from('organisations').delete().eq('id', orgId)
  }
})

async function metrics(): Promise<PipelineMetrics> {
  const all = await getMetricsForOrganisations(supabase, [{ id: orgId, name: ORG_NAME }])
  return all[0]
}

describe('batch funnels reconcile with the organisation-wide cards', () => {
  it('sums the batch lines plus the unattributed group to the card figure', async () => {
    const m = await metrics()

    const batchTier1 = m.batches.reduce((n, b) => n + b.tiers.tier_1.total, 0)
    const unattributedTier1 = m.unattributed?.tiers.tier_1.total ?? 0

    // 4 in runs, 1 in no run, 5 on the card.
    expect(batchTier1).toBe(4)
    expect(unattributedTier1).toBe(1)
    expect(batchTier1 + unattributedTier1).toBe(m.tiers.tier_1.total)
    expect(m.tiers.tier_1.total).toBe(5)
  })

  it('reconciles the removed count the same way', async () => {
    const m = await metrics()

    const batchRemoved = m.batches.reduce((n, b) => n + b.removed, 0)
    const unattributedRemoved = m.unattributed?.removed ?? 0

    expect(batchRemoved).toBe(1)
    expect(batchRemoved + unattributedRemoved).toBe(m.removed_count)
  })

  it('reconciles the total prospect count', async () => {
    const m = await metrics()

    const inRuns = m.batches.reduce((n, b) => n + b.sourced, 0)
    const outsideRuns = m.unattributed?.sourced ?? 0

    expect(inRuns).toBe(5)
    expect(outsideRuns).toBe(1)
    expect(inRuns + outsideRuns).toBe(6)
  })

  // A prospect belonging to no run is a REAL STATE, not an error, and the whole point is
  // that it is shown. A screen that dropped it would still reconcile against itself and
  // would be quietly missing a row.
  it('never silently drops a prospect that belongs to no run', async () => {
    const m = await metrics()

    expect(m.unattributed).not.toBeNull()
    expect(m.unattributed!.sourced).toBe(1)
    expect(m.unattributed!.sourcing_run_id).toBeNull()
  })

  // Mutation: build the run list by grouping prospects instead of from sourcing_runs and
  // this goes red, because the run with no surviving rows disappears entirely.
  it('keeps a line for a run whose prospects no longer exist', async () => {
    const m = await metrics()

    const gone = m.batches.find(b => b.sourcing_run_id === runWhoseRowsAreGone)
    expect(gone).toBeDefined()
    expect(gone!.sourced).toBe(0)
    // What the run recorded is still there to be read beside the nothing it now has.
    expect(gone!.candidates_returned).toBe(25)
  })

  it('orders the run list newest first, so the newest is the one expanded by default', async () => {
    const m = await metrics()

    const startedAt = m.batches.map(b => b.started_at)
    const sortedDesc = [...startedAt].sort().reverse()
    expect(startedAt).toEqual(sortedDesc)
    expect(m.batches[0].sourcing_run_id).toBe(runWhoseRowsAreGone)
  })

  // Two runs ONE MINUTE apart. This is the case that defeated timestamp clustering on
  // production, where four runs inside three minutes were reported as one batch of 29.
  it('separates two runs a minute apart', async () => {
    const m = await metrics()

    const a = m.batches.find(b => b.sourcing_run_id === runWithProspects)
    const b = m.batches.find(b2 => b2.sourcing_run_id === runWithProspectsB)

    expect(a!.sourced).toBe(3)
    expect(b!.sourced).toBe(2)
  })
})
