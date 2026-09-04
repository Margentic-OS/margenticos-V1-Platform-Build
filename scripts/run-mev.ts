#!/usr/bin/env npx tsx
/**
 * Independently verify one organisation's enriched prospect emails, from the command line.
 *
 * Run with:
 *   npx tsx --env-file=.env.local scripts/run-mev.ts --org <uuid> [--size <n>] --confirm-spend
 *
 * ─── THIS ONE SPENDS MONEY ───────────────────────────────────────────────────
 *
 * Every prospect it processes is one paid verification call, and the ledger of those
 * calls is what the spend is read from afterwards. It also WRITES email_send_eligible,
 * which per ADR-034 is a materialised verdict: once written, nothing re-evaluates it
 * without paying again.
 *
 * --org WAS HARDCODED to one organisation id, with no flag to change it, in a script
 * that spends per row. Running it while thinking about a different client would have
 * bought verification for MargenticOS's prospects and frozen their eligibility verdicts.
 * It is required rather than defaulted for exactly that reason.
 *
 * --confirm-spend is required as well, and only on this script. run-sourcing and
 * run-tiering are free, so a mistyped organisation id there costs a run. Here it costs
 * money and freezes a verdict, and a flag that has to be typed is the cheapest thing
 * that separates "I meant this client" from "I ran the last command again".
 */

import { createClient } from '@supabase/supabase-js'
import type { Database } from '../src/types/database'
import { asServiceRoleClient } from '../src/lib/supabase/service-role'
import { myemailverifierHandler } from '../src/lib/sourcing/handlers/adapter-myemailverifier'

const DEFAULT_BATCH_SIZE = 100

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function usage(message: string): never {
  console.error(`\n${message}\n`)
  console.error('Usage:')
  console.error('  npx tsx --env-file=.env.local scripts/run-mev.ts --org <uuid> [--size <n>] --confirm-spend')
  console.error('')
  console.error('  --org            organisation id. Required, never defaulted.')
  console.error(`  --size           how many prospects to verify. Optional, default ${DEFAULT_BATCH_SIZE}.`)
  console.error('  --confirm-spend  required. One paid verification call per prospect.')
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

  if (!process.argv.includes('--confirm-spend')) {
    usage('Missing --confirm-spend. This script makes one PAID verification call per prospect.')
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

  const { data: prospects, error } = await supabase
    .from('prospects')
    .select('id, email, independent_email_status')
    .eq('organisation_id', orgId)
    .eq('enrichment_status', 'enriched')
    .not('email', 'is', null)
    .limit(size)

  if (error) {
    console.error('Error fetching prospects:', error.message)
    process.exit(1)
  }

  if (!prospects || prospects.length === 0) {
    console.log(`No enriched prospects with emails for ${org.name}. Nothing to verify, nothing spent.`)
    process.exit(0)
  }

  console.log('')
  console.log('  Independent verification run')
  console.log(`  Organisation : ${org.name} (${orgId})`)
  console.log(`  Prospects    : ${prospects.length}`)
  console.log('  PAID: one verification call per prospect. Writes email_send_eligible,')
  console.log('  which is frozen on the row and is not re-evaluated without paying again.')
  console.log('')

  const results = {
    valid: 0,
    invalid: 0,
    unknown: 0,
    catch_all: 0,
    total: prospects.length,
    eligible: 0,
  }

  for (const prospect of prospects) {
    if (!prospect.email) continue

    try {
      const result = await myemailverifierHandler.execute(prospect.email)

      switch (result.status) {
        case 'Valid':
          results.valid++
          break
        case 'Invalid':
          results.invalid++
          break
        case 'Catch All':
          results.catch_all++
          break
        case 'Unknown':
          results.unknown++
          break
      }

      if (result.send_eligible) results.eligible++

      await supabase
        .from('prospects')
        .update({
          independent_email_status: result.status,
          email_send_eligible: result.send_eligible,
          independent_verified_at: result.verified_at,
          verification_provider: 'myemailverifier',
        })
        .eq('id', prospect.id)

      // Rate limiting: 30 per minute = one every 2 seconds
      await new Promise(r => setTimeout(r, 2000))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`  ⚠ ${prospect.email}: ${msg}`)
    }
  }

  console.log('')
  console.log('  Verification complete:')
  console.log(`  Valid         : ${results.valid}`)
  console.log(`  Invalid       : ${results.invalid}`)
  console.log(`  Unknown       : ${results.unknown}`)
  console.log(`  Catch All     : ${results.catch_all}`)
  console.log(`  Send-eligible : ${results.eligible}/${results.total}`)
  console.log('')
}

main().catch(err => {
  console.error('Verification run crashed:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
