#!/usr/bin/env npx tsx
/**
 * Generate ONE missing variant into an existing pending messaging suggestion.
 *
 *   npx tsx --env-file=.env.local scripts/repair-missing-variant.ts \
 *     --suggestion <uuid> --variant <A|B|C|D> [--write]
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 *
 * A messaging run is bounded by MAX_API_CALLS_PER_RUN and drops any slot the budget does
 * not reach. A slot dropped that way never failed on its merits, and the only recovery
 * was a full regeneration: a whole budget spent rewriting three variants that were
 * already good, with no guarantee of filling the fourth either.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT IT WRITES, AND WHAT IT MUST NEVER TOUCH
 *
 * ONE KEY: suggested_value.variants.<variant> on the named pending row, plus a sentence
 * appended to suggestion_reason so the row does not go on claiming the variant was
 * dropped. No other column, no other row, no other table. It does not write
 * strategy_documents, does not approve, and does not reject.
 *
 * The surviving variants are fingerprinted from the database before any work and from a
 * read-back after the write. Any difference outside the added key fails the run.
 *
 * DRY BY DEFAULT. Without --write it reports what it found and what it would do, and
 * makes no model call and no write, so the target can be checked before money is spent.
 * The dry run performs every check the real run performs, the source-document provenance
 * guard included, so a clean dry run means the repair would actually proceed.
 *
 * REFUSES IF THE SOURCE DOCUMENTS HAVE MOVED. A repair fills a slot alongside copy written
 * from a known ICP, Positioning and TOV. If any of the three has been approved anew since,
 * filling the slot is a partial regeneration rather than a repair, and the run stops.
 */

import { createClient } from '@supabase/supabase-js'
import {
  MAX_REPAIR_API_CALLS,
  loadRepairTarget,
  runMessagingVariantRepair,
  verifyRepairContext,
} from '@/agents/messaging-variant-repair-agent'
import { formatSourceVersions } from '@/lib/messaging/source-provenance'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const suggestionId = arg('suggestion')
  const variantKey = arg('variant')
  const write = process.argv.includes('--write')

  if (!suggestionId || !variantKey) {
    console.error('\nUsage: repair-missing-variant.ts --suggestion <uuid> --variant <A|B|C|D> [--write]\n')
    process.exit(1)
  }

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

  // The SAME preflight the real run performs, not a second copy of it. Throws if the row
  // is the wrong kind or not pending, if the target slot is already present, or if a
  // survivor is malformed. All of it before any spend.
  const target = await loadRepairTarget(supabase, suggestionId, variantKey)

  console.log(`\nSuggestion ${suggestionId}`)
  console.log(`  organisation  ${target.organisation_id}`)
  console.log(`\n  surviving variants: ${Object.keys(target.survivors).sort().join(', ')}`)
  for (const key of [...target.fingerprintsBefore.keys()].sort()) {
    console.log(`    ${key}  sha256 ${target.fingerprintsBefore.get(key)}`)
  }

  // THE PROVENANCE GUARD RUNS IN THE DRY RUN TOO. Six database reads, no model call, so
  // it costs nothing and proves the guard against live data rather than a fixture. A dry
  // run that skipped it would report a repair as safe using a check the real run performs
  // and it does not, which is worse than not checking at all.
  const { sourceVersions } = await verifyRepairContext(supabase, target, variantKey)
  console.log(`\n  source documents VERIFIED UNCHANGED since the survivors were written:`)
  console.log(`    ${formatSourceVersions(sourceVersions)}`)

  console.log(`\n  would generate: ${variantKey}, budget ${MAX_REPAIR_API_CALLS} call(s)`)

  if (!write) {
    console.log('\n  NOTHING WRITTEN (dry run). Re-run with --write to generate and store.\n')
    return
  }

  const result = await runMessagingVariantRepair({ suggestion_id: suggestionId, variant_key: variantKey, supabase })

  console.log(`\n  WROTE variant ${result.variant_key} (shipped angle: ${result.shipped_angle})`)
  console.log(`  api calls: ${result.api_calls_used}, duration ${Math.round(result.duration_ms / 1000)}s`)
  console.log(`  variants now: ${result.variants_after.join(', ')}`)
  console.log(`  written against: ${formatSourceVersions(result.source_versions)}`)
  console.log('\n  POSITIVE CONTROL — surviving variants, read back from the database:')
  let allHeld = true
  for (const key of [...target.fingerprintsBefore.keys()].sort()) {
    const held = result.preserved_fingerprints[key] === target.fingerprintsBefore.get(key)
    if (!held) allHeld = false
    console.log(`    ${key}  ${held ? 'UNCHANGED' : 'CHANGED'}  ${result.preserved_fingerprints[key]}`)
  }
  console.log(`\n  ${allHeld ? 'All surviving variants byte-identical.' : 'A SURVIVING VARIANT CHANGED — investigate before approving.'}\n`)
}

main().catch(err => {
  console.error(`\nrepair-missing-variant failed: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
