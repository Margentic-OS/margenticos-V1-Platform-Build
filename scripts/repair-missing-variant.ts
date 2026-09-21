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
 */

import { createClient } from '@supabase/supabase-js'
import {
  MAX_REPAIR_API_CALLS,
  readSurvivingVariants,
  runMessagingVariantRepair,
} from '@/agents/messaging-variant-repair-agent'
import { variantFingerprints } from '@/lib/messaging/variant-payload'

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

  const { data: row, error } = await supabase
    .from('document_suggestions')
    .select('id, organisation_id, document_type, field_path, status, suggested_value, created_at')
    .eq('id', suggestionId)
    .single()

  if (error || !row) throw new Error(`could not read suggestion ${suggestionId}: ${error?.message ?? 'no row'}`)

  console.log(`\nSuggestion ${row.id}`)
  console.log(`  organisation  ${row.organisation_id}`)
  console.log(`  type          ${row.document_type} / ${row.field_path}`)
  console.log(`  status        ${row.status}`)
  console.log(`  created       ${row.created_at}`)

  // Throws if the target is already present or a survivor is malformed, before any spend.
  const survivors = readSurvivingVariants(row.suggested_value as string | null, variantKey)
  const before = variantFingerprints(row.suggested_value as string | null)

  console.log(`\n  surviving variants: ${Object.keys(survivors).sort().join(', ')}`)
  for (const key of [...before.keys()].sort()) {
    console.log(`    ${key}  sha256 ${before.get(key)}`)
  }
  console.log(`\n  would generate: ${variantKey}, budget ${MAX_REPAIR_API_CALLS} call(s)`)

  if (!write) {
    console.log('\n  NOTHING WRITTEN (dry run). Re-run with --write to generate and store.\n')
    return
  }

  const result = await runMessagingVariantRepair({ suggestion_id: suggestionId, variant_key: variantKey, supabase })

  console.log(`\n  WROTE variant ${result.variant_key} (shipped angle: ${result.shipped_angle})`)
  console.log(`  api calls: ${result.api_calls_used}, duration ${Math.round(result.duration_ms / 1000)}s`)
  console.log(`  variants now: ${result.variants_after.join(', ')}`)
  console.log('\n  POSITIVE CONTROL — surviving variants, read back from the database:')
  let allHeld = true
  for (const key of [...before.keys()].sort()) {
    const held = result.preserved_fingerprints[key] === before.get(key)
    if (!held) allHeld = false
    console.log(`    ${key}  ${held ? 'UNCHANGED' : 'CHANGED'}  ${result.preserved_fingerprints[key]}`)
  }
  console.log(`\n  ${allHeld ? 'All surviving variants byte-identical.' : 'A SURVIVING VARIANT CHANGED — investigate before approving.'}\n`)
}

main().catch(err => {
  console.error(`\nrepair-missing-variant failed: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
