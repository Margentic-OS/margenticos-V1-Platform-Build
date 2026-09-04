#!/usr/bin/env npx tsx
/**
 * Tier one organisation's enriched prospects, from the command line.
 *
 * Run with:
 *   npx tsx --env-file=.env.local scripts/run-tiering.ts --org <uuid> [--size <n>]
 *
 * Spends nothing. Tiering makes no model call and no provider call: it reads enriched
 * rows, applies the client's stored filter spec, and writes sourced_tier.
 *
 * --org WAS HARDCODED to one organisation id, with no flag to change it. That is the
 * same defect scripts/run-sourcing.ts was written to remove, and it is worse in a script
 * that writes: running it while thinking about a different client silently re-tiered
 * MargenticOS. It is required rather than defaulted for exactly that reason. A default
 * organisation id is a script that does something plausible when you meant something
 * else, and sourced_tier is a materialised verdict that nothing re-evaluates.
 */

import { createClient } from '@supabase/supabase-js'
import type { Database } from '../src/types/database'
import { asServiceRoleClient } from '../src/lib/supabase/service-role'
import { tierEnrichedBatch } from '../src/lib/sourcing/tiering-trigger'

const DEFAULT_BATCH_SIZE = 100

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function usage(message: string): never {
  console.error(`\n${message}\n`)
  console.error('Usage:')
  console.error('  npx tsx --env-file=.env.local scripts/run-tiering.ts --org <uuid> [--size <n>]')
  console.error('')
  console.error('  --org   organisation id. Required, never defaulted.')
  console.error(`  --size  how many enriched prospects to classify. Optional, default ${DEFAULT_BATCH_SIZE}.`)
  console.error('')
  process.exit(1)
}

async function main() {
  const orgId = arg('org')
  if (!orgId) usage('Missing --org.')

  const sizeRaw = arg('size')
  const size = sizeRaw === undefined ? DEFAULT_BATCH_SIZE : Number(sizeRaw)
  if (!Number.isInteger(size) || size < 1) {
    usage(`--size must be a whole number of 1 or more, got "${sizeRaw}".`)
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    usage('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. Pass --env-file=.env.local.')
  }

  const supabase = asServiceRoleClient(createClient<Database>(url, key))

  const { data: org } = await supabase
    .from('organisations')
    .select('name')
    .eq('id', orgId)
    .single()

  if (!org) usage(`No organisation with id ${orgId}.`)

  console.log('')
  console.log('  Tiering run')
  console.log(`  Organisation : ${org.name} (${orgId})`)
  console.log(`  Batch size   : ${size}`)
  console.log('  Spends nothing. Writes sourced_tier and tiering_reason.')
  console.log('')

  const result = await tierEnrichedBatch(supabase, orgId, size)

  console.log(`  Prospects classified : ${result.prospects_classified}`)
  console.log(`  Tier 1               : ${result.tier_1_count}`)
  console.log(`  Tier 2               : ${result.tier_2_count}`)
  console.log(`  Tier 3               : ${result.tier_3_count}`)
  console.log(`  Untiered             : ${result.untiered_count}`)
  if (result.error) {
    console.error('')
    console.error(`  FAILED: ${result.error}`)
    console.error('')
    process.exit(1)
  }
  console.log('')
}

main().catch(err => {
  console.error('Tiering run crashed:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
