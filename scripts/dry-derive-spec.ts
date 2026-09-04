#!/usr/bin/env npx tsx
/**
 * Run spec derivation against every organisation's CURRENT active ICP and print what it
 * would produce, beside what is stored. WRITES NOTHING. The derived value is discarded.
 *
 *   npx tsx --env-file=.env.local scripts/dry-derive-spec.ts
 *
 * WHY THIS EXISTS. Derivation runs only on document promotion, and promotion OVERWRITES
 * the stored spec. For two live clients that stored spec is the only working sourcing
 * configuration there is, so "approve the document and see what happens" is not a test,
 * it is the change. This runs the same pure function on the same input and throws the
 * answer away.
 *
 * IT NOW SPENDS, AND IT DID NOT USED TO. deriveFilterSpec is still pure, but geography is
 * no longer a hardcoded constant: it is derived per client from that client's own ICP by
 * ONE Anthropic call per organisation, via resolveIcpGeography. That is the whole point of
 * the change, and there is no cheaper way to preview it, because the answer is a reading
 * of the client's prose rather than a lookup.
 *
 * The buyer criterion, which also costs a call, is still READ FROM THE STORED SPEC and
 * passed in rather than re-derived, so the cost is one call per organisation and not two.
 *
 * STILL WRITES NOTHING. Every derived value is printed and discarded.
 */

import { createClient } from '@supabase/supabase-js'
import type { Database } from '../src/types/database'
import { deriveFilterSpec, type IcpDocument } from '../src/lib/agents/icp-filter-spec'
import type { ICPFilterSpec } from '../src/lib/agents/icp-filter-spec'
import { resolveIcpGeography, type ResolvedGeography } from '../src/lib/sourcing/resolve-icp-geography'

function show(label: string, value: unknown): string {
  return `  ${label.padEnd(22)} ${JSON.stringify(value)}`
}

async function main() {
  const supabase = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

  const { data: docs } = await supabase
    .from('strategy_documents')
    .select('id, organisation_id, content, icp_filter_spec, organisations(name)')
    .eq('document_type', 'icp').eq('status', 'active')

  for (const row of (docs ?? []).sort((a: any, b: any) =>
      String(a.organisations?.name).localeCompare(String(b.organisations?.name)))) {
    const r = row as any
    const name = r.organisations?.name ?? r.organisation_id
    const stored = (r.icp_filter_spec ?? null) as ICPFilterSpec | null

    console.log(`\n${'='.repeat(78)}\n${name}   doc ${String(r.id).slice(0, 8)}`)

    // Geography first, because it is the half that changed and the half that can refuse.
    // Its failure is reported and the derivation is skipped, which is exactly what
    // persistIcpFilterSpec does in production: it fails closed and writes no spec at all.
    let geography: ResolvedGeography | null = null
    try {
      geography = await resolveIcpGeography({
        supabase: supabase as never,
        doc: r.content as unknown as IcpDocument,
      })
      console.log(show('derived countries', geography.countries))
      console.log(show('  subtracted', geography.removed_by_exclusion))
      console.log(show('  named no country', geography.unresolved_phrases))
    } catch (e) {
      console.log(`  GEOGRAPHY REFUSES: ${(e as Error).message}`)
    }

    let derived: ICPFilterSpec | null = null
    if (geography) {
      try {
        derived = deriveFilterSpec(
          r.content as unknown as IcpDocument,
          stored?.buyer_criterion ?? null,
          geography,
        )
      } catch (e) {
        console.log(`  DERIVATION REFUSES: ${(e as Error).message}`)
      }
    }

    for (const field of ['industries', 'keywords', 'job_titles', 'seniority_levels',
                         'person_countries', 'company_headcount_min', 'company_headcount_max'] as const) {
      console.log(show(`derived ${field}`, derived ? (derived as any)[field] : null))
      if (stored) {
        const s = (stored as any)[field]
        const same = JSON.stringify(s) === JSON.stringify(derived ? (derived as any)[field] : undefined)
        console.log(show(`  stored ${field}`, s) + (same ? '   [same]' : '   [DIFFERS]'))
      } else {
        console.log(`  ${'stored'.padEnd(22)} (no stored spec)`)
      }
    }
  }
  console.log('\nNothing was written. Every derived value above was discarded.\n')
}
main().catch(e => { console.error(e); process.exit(1) })
