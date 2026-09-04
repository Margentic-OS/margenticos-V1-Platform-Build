#!/usr/bin/env npx tsx
/**
 * Re-run classification over one organisation's EXISTING prospects and diff the result
 * against the tier already stored on the row. Report only.
 *
 * Run with:
 *   npx tsx --env-file=.env.local scripts/compare-tiering.ts --org <uuid>
 *
 * WRITES NOTHING, and that is the entire point of it existing next to run-tiering.ts.
 * `sourced_tier` is a materialised verdict: nothing re-evaluates it once written except
 * the thaw in persistIcpFilterSpec. So a change to classifyTier is invisible until it is
 * applied, and applying it to find out what it does is the wrong order. This runs the new
 * code against the stored rows and prints the movement before anything is committed to.
 *
 * Spends nothing. Classification makes no model call and no provider call.
 */

import { createClient } from '@supabase/supabase-js'
import type { Database } from '../src/types/database'
import { classifyTier, type EnrichedProspect } from '../src/lib/sourcing/tier-classification'
import type { ICPFilterSpec } from '../src/lib/agents/icp-filter-spec'

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

  const supabase = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { data: org } = await supabase
    .from('organisations').select('id, name').eq('id', orgId).single()
  if (!org) { console.error(`  Unknown organisation ${orgId}`); process.exit(1) }

  const { data: doc } = await supabase
    .from('strategy_documents')
    .select('id, icp_filter_spec')
    .eq('organisation_id', orgId).eq('document_type', 'icp').eq('status', 'active')
    .single()

  if (!doc?.icp_filter_spec) {
    console.error(`  ${org.name} has no active ICP filter spec. Sourcing would refuse.`)
    process.exit(1)
  }
  const spec = doc.icp_filter_spec as unknown as ICPFilterSpec

  const { data: prospects } = await supabase
    .from('prospects')
    .select('id, organisation_id, email_status, enrichment_status, job_title, company_headcount, company_industry, company_name, sourced_tier, tiering_reason, fit_score')
    .eq('organisation_id', orgId)

  const rows = prospects ?? []
  console.log(`\n${org.name}  (${orgId})`)
  console.log(`  prospects: ${rows.length}`)
  console.log(`  spec: headcount ${spec.company_headcount_min}-${spec.company_headcount_max}, ` +
              `${spec.industries?.length ?? 0} industries, ${spec.keywords?.length ?? 0} keywords, ` +
              `buyer_criterion ${spec.buyer_criterion ? 'present' : 'ABSENT'}`)

  const before: Record<string, number> = {}
  const after: Record<string, number> = {}
  const moved: string[] = []
  const recomputed: Array<number | null> = []
  let reasonDrift = 0

  for (const p of rows) {
    const storedTier = p.sourced_tier ?? 'removed'
    before[storedTier] = (before[storedTier] ?? 0) + 1

    const result = await classifyTier(p as unknown as EnrichedProspect, spec, supabase)
    recomputed.push(result.fit_score)
    const newTier = result.sourced_tier ?? 'removed'
    after[newTier] = (after[newTier] ?? 0) + 1

    if ((p.tiering_reason ?? null) !== result.tiering_reason) reasonDrift++

    if (storedTier !== newTier) {
      moved.push(`    ${p.id.slice(0, 8)}  ${storedTier} -> ${newTier}   ` +
                 `[was: ${p.tiering_reason ?? 'null'}] [now: ${result.tiering_reason}]`)
    }
  }

  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  console.log('\n  tier            stored    recomputed   delta')
  for (const k of keys) {
    const b = before[k] ?? 0, a = after[k] ?? 0
    console.log(`  ${k.padEnd(14)} ${String(b).padStart(6)} ${String(a).padStart(12)} ${(a - b >= 0 ? '+' : '') + (a - b)}`)
  }

  // Score distribution, because a tier count hides movement INSIDE a tier. A change that
  // shifts every survivor by 20 points without crossing a threshold reads as "no movement"
  // on tiers alone, and is the change most likely to cross one on the next batch.
  const bucket = (n: number | null) => n === null ? 'removed' : `${Math.floor(n / 10) * 10}-${Math.floor(n / 10) * 10 + 9}`
  const sBefore: Record<string, number> = {}, sAfter: Record<string, number> = {}
  for (const p of rows) {
    sBefore[bucket(p.fit_score as number | null)] = (sBefore[bucket(p.fit_score as number | null)] ?? 0) + 1
  }
  for (const r of recomputed) sAfter[bucket(r)] = (sAfter[bucket(r)] ?? 0) + 1
  const sKeys = [...new Set([...Object.keys(sBefore), ...Object.keys(sAfter)])].sort()
  console.log('\n  fit score      stored    recomputed')
  for (const k of sKeys) {
    console.log(`  ${k.padEnd(13)} ${String(sBefore[k] ?? 0).padStart(6)} ${String(sAfter[k] ?? 0).padStart(12)}`)
  }

  console.log(`\n  rows whose stored tiering_reason string differs from recomputed: ${reasonDrift}`)
  console.log(`  rows whose tier changed: ${moved.length}`)
  for (const line of moved.slice(0, 40)) console.log(line)
  if (moved.length > 40) console.log(`    ... and ${moved.length - 40} more`)
  console.log('')
}

main().catch(e => { console.error(e); process.exit(1) })
