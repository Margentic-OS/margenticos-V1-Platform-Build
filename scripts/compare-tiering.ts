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
    .select('id, organisation_id, email_status, enrichment_status, job_title, company_headcount, company_industry, company_name, sourced_tier, tiering_reason')
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

  for (const p of rows) {
    const storedTier = p.sourced_tier ?? 'removed'
    before[storedTier] = (before[storedTier] ?? 0) + 1

    const result = await classifyTier(p as unknown as EnrichedProspect, spec, supabase)
    const newTier = result.sourced_tier ?? 'removed'
    after[newTier] = (after[newTier] ?? 0) + 1

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

  console.log(`\n  rows whose tier changed: ${moved.length}`)
  for (const line of moved.slice(0, 40)) console.log(line)
  if (moved.length > 40) console.log(`    ... and ${moved.length - 40} more`)
  console.log('')
}

main().catch(e => { console.error(e); process.exit(1) })
