#!/usr/bin/env npx tsx
/**
 * Source prospects for one organisation, from the command line.
 *
 * Run with:
 *   npx tsx --env-file=.env.local scripts/run-sourcing.ts --org <uuid> --size <n>
 *
 * This calls the SAME entry point the operator dashboard calls
 * (src/lib/operator/sourcing-entry.ts), so a run from here and a click in the dashboard
 * make identical decisions about caps, archived organisations and concurrent runs.
 *
 * It replaces scripts/phase4-real.ts, phase4-final.ts and phase4-backfill.ts, all three of
 * which hardcoded one organisation id and one batch size. Nothing is hardcoded here.
 *
 * Reach for the dashboard first. This exists for the cases a browser cannot cover: a batch
 * from a terminal, a scripted run, or a client whose record is not yet visible in the UI.
 */

import { createClient } from '@supabase/supabase-js'
import type { Database } from '../src/types/database'
import { asServiceRoleClient } from '../src/lib/supabase/service-role'
import { runSourcingForOrg, SOURCING_MAX_BATCH_SIZE } from '@/lib/operator/sourcing-entry'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function usage(message: string): never {
  console.error(`\n${message}\n`)
  console.error('Usage:')
  console.error('  npx tsx --env-file=.env.local scripts/run-sourcing.ts --org <uuid> --size <n>')
  console.error('')
  console.error('  --org   organisation id. Required. Must not be archived.')
  console.error(`  --size  how many prospects to ask for. Required. 1 to ${SOURCING_MAX_BATCH_SIZE}.`)
  console.error('')
  process.exit(1)
}

async function main() {
  const orgId = arg('org')
  const sizeRaw = arg('size')

  if (!orgId) usage('Missing --org.')
  if (!sizeRaw) usage('Missing --size.')

  const size = Number(sizeRaw)
  if (!Number.isInteger(size) || size < 1) usage(`--size must be a whole number of 1 or more, got "${sizeRaw}".`)

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) usage('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. Pass --env-file=.env.local.')

  // Typed AND branded. It was an untyped createClient(url, key), so neither the row
  // types nor the service-role requirement were checked at this boundary.
  const supabase = asServiceRoleClient(createClient<Database>(url, key))

  const { data: org } = await supabase
    .from('organisations')
    .select('name')
    .eq('id', orgId)
    .single()

  console.log('')
  console.log('  Sourcing run')
  console.log(`  Organisation : ${org?.name ?? 'unknown'} (${orgId})`)
  console.log(`  Batch size   : ${size}`)
  console.log('  Spends Apollo credits. Needs a client-approved ICP.')
  console.log('')

  const result = await runSourcingForOrg({
    supabase,
    organisation_id: orgId,
    target_batch_size: size,
    trigger_type: 'operator_manual',
  })

  if (!result.ok) {
    console.error('')
    console.error(`  REFUSED OR FAILED: ${result.error}`)
    console.error('')
    process.exit(1)
  }

  console.log('')
  console.log(`  Candidates returned : ${result.candidates_sourced}`)
  console.log(`  Written as new      : ${result.candidates_qualified}`)
  console.log(`  Already known       : ${result.candidates_sourced - result.candidates_qualified}`)
  console.log('')
}

main().catch(err => {
  console.error('Sourcing run crashed:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
