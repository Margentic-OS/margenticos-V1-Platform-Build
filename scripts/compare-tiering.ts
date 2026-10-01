#!/usr/bin/env npx tsx
/**
 * Re-run classification over one organisation's EXISTING prospects and diff the result
 * against the tier already stored on the row. Report only.
 *
 * Run with:
 *   npx tsx --env-file=.env.local scripts/compare-tiering.ts --org <uuid>
 *   npx tsx --env-file=.env.local scripts/compare-tiering.ts --org <uuid> --proposed
 *
 * WRITES NOTHING, and that is the entire point of it existing next to run-tiering.ts.
 * `sourced_tier` is a materialised verdict: nothing re-evaluates it once written except
 * the thaw on an approved settings change (ADR-061). So a change to classifyTier is invisible until it is
 * applied, and applying it to find out what it does is the wrong order. This runs the new
 * code against the stored rows and prints the movement before anything is committed to.
 *
 * `--proposed` replays against the PROPOSED search settings waiting on the active ICP,
 * instead of the live ones. That is the terminal's view of what the operator's
 * before-and-after panel shows.
 *
 * ONE REPLAY, SHARED WITH THE PANEL. The read and the classification are
 * src/lib/sourcing/tiering-replay.ts, which the panel calls too, so the two cannot
 * disagree about how a set of settings judges a prospect. Two consequences of sharing it,
 * both changes from how this script used to behave:
 *
 *   - It replays ENRICHED prospects only. Those are the ones tiering can judge. A prospect
 *     never enriched has no verified email on file and reads "removed" under any settings.
 *   - It reads in pages. A single select stops at 1,000 rows and says nothing about the
 *     rest, and this used to be a single select.
 *
 * Spends nothing. Classification makes no model call and no provider call.
 */

import { createClient } from '@supabase/supabase-js'
import type { Database } from '../src/types/database'
import type { ICPFilterSpec } from '../src/lib/agents/icp-filter-spec'
import {
  countByState,
  countMovements,
  fetchEnrichedProspects,
  REPLAY_STATES,
  replayTiering,
} from '../src/lib/sourcing/tiering-replay'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const orgId = arg('org')
  if (!orgId) {
    console.error('\n  --org <uuid> is required, never defaulted.\n')
    process.exit(1)
  }
  const useProposed = process.argv.includes('--proposed')

  const supabase = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { data: org } = await supabase
    .from('organisations').select('id, name').eq('id', orgId).single()
  if (!org) { console.error(`  Unknown organisation ${orgId}`); process.exit(1) }

  const { data: doc } = await supabase
    .from('strategy_documents')
    .select('id, icp_filter_spec, icp_filter_spec_proposed')
    .eq('organisation_id', orgId).eq('document_type', 'icp').eq('status', 'active')
    .single()

  const stored = useProposed ? doc?.icp_filter_spec_proposed : doc?.icp_filter_spec
  if (!stored) {
    console.error(useProposed
      ? `  ${org.name} has no proposed search settings waiting on its active ICP.`
      : `  ${org.name} has no active ICP filter spec. Sourcing would refuse.`)
    process.exit(1)
  }
  const spec = stored as unknown as ICPFilterSpec

  const rows = await fetchEnrichedProspects(supabase, orgId)
  console.log(`\n${org.name}  (${orgId})`)
  console.log(`  settings: ${useProposed ? 'PROPOSED, not yet approved' : 'live'}`)
  console.log(`  enriched prospects: ${rows.length}`)
  console.log(`  spec: headcount ${spec.company_headcount_min}-${spec.company_headcount_max}, ` +
              `${spec.industries?.length ?? 0} industries, ${spec.keywords?.length ?? 0} keywords, ` +
              `buyer_criterion ${spec.buyer_criterion ? 'present' : 'ABSENT'}`)

  const verdicts = await replayTiering(rows, spec, supabase)

  const before = countByState(verdicts.map(v => v.stored))
  const after = countByState(verdicts.map(v => v.replayed))
  console.log('\n  state           stored    recomputed   delta')
  for (const state of REPLAY_STATES) {
    const b = before[state], a = after[state]
    if (b === 0 && a === 0) continue
    console.log(`  ${state.padEnd(14)} ${String(b).padStart(6)} ${String(a).padStart(12)} ${(a - b >= 0 ? '+' : '') + (a - b)}`)
  }

  // Score distribution, because a tier count hides movement INSIDE a tier. A change that
  // shifts every survivor by 20 points without crossing a threshold reads as "no movement"
  // on tiers alone, and is the change most likely to cross one on the next batch.
  const bucket = (n: number | null) => n === null ? 'no score' : `${Math.floor(n / 10) * 10}-${Math.floor(n / 10) * 10 + 9}`
  const sBefore: Record<string, number> = {}, sAfter: Record<string, number> = {}
  for (const v of verdicts) {
    sBefore[bucket(v.stored_score)] = (sBefore[bucket(v.stored_score)] ?? 0) + 1
    sAfter[bucket(v.replayed_score)] = (sAfter[bucket(v.replayed_score)] ?? 0) + 1
  }
  const sKeys = [...new Set([...Object.keys(sBefore), ...Object.keys(sAfter)])].sort()
  console.log('\n  fit score      stored    recomputed')
  for (const k of sKeys) {
    console.log(`  ${k.padEnd(13)} ${String(sBefore[k] ?? 0).padStart(6)} ${String(sAfter[k] ?? 0).padStart(12)}`)
  }

  const reasonDrift = verdicts.filter(v => (v.stored_reason ?? null) !== v.replayed_reason).length
  const movements = countMovements(verdicts.map(v => ({ from: v.stored, to: v.replayed })))
  const moved = verdicts.filter(v => v.stored !== v.replayed)

  console.log(`\n  rows whose stored tiering_reason string differs from recomputed: ${reasonDrift}`)
  console.log(`  rows whose state changed: ${moved.length}`)
  for (const m of movements) console.log(`    ${m.from} -> ${m.to}: ${m.count}`)
  for (const v of moved.slice(0, 40)) {
    console.log(`    ${v.id.slice(0, 8)}  ${v.stored} -> ${v.replayed}   ` +
                `[was: ${v.stored_reason ?? 'null'}] [now: ${v.replayed_reason}]`)
  }
  if (moved.length > 40) console.log(`    ... and ${moved.length - 40} more`)
  console.log('')
}

main().catch(e => { console.error(e); process.exit(1) })
