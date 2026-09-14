#!/usr/bin/env npx tsx
/**
 * Derive each client's fit conditions once and store them on their settings.
 *
 *   npx tsx --env-file=.env.local scripts/backfill-fit-dimensions.ts --org <uuid> [--write]
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY A BACKFILL EXISTS AT ALL
 *
 * The condition list is derived at profile approval and read every time after. Clients whose
 * profile was approved BEFORE that step existed have no list, and every consumer of one
 * silently falls back to deriving its own: the sampler made an Opus call per run, and a rate
 * measured against a standard derived fresh each time cannot be compared with last month's.
 *
 * This is the one-off that gives the existing clients what a newly approved one gets.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT IT WRITES, AND WHAT IT MUST NEVER TOUCH
 *
 * ONE KEY: icp_filter_spec.fit_dimensions, merged in. Every other key of the spec is carried
 * through untouched, and no other column, row or table is written. It does not re-approve the
 * profile, does not regenerate a document, and does not touch prospects.
 *
 * DRY BY DEFAULT. Without --write it derives, prints, and stores nothing, so the list can be
 * read before it is stored. The derivation costs the same either way, which is the point: the
 * expensive half is separated from the writing half.
 *
 * REFUSES TO OVERWRITE. A client that already has a list keeps it. Replacing one silently
 * would move the standard under every run already measured against it, which is the exact
 * failure the stored list exists to prevent.
 */

import { createClient } from '@supabase/supabase-js'
import { deriveFitDimensions, collectFitStatements } from '@/agents/fit-dimensions-agent'
import type { IcpDocument } from '@/lib/agents/icp-filter-spec'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const organisationId = arg('org')
  const write = process.argv.includes('--write')
  if (!organisationId) {
    console.error('\nUsage: backfill-fit-dimensions.ts --org <uuid> [--write]\n')
    process.exit(1)
  }

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

  // EXACTLY ONE ACTIVE PROFILE, or stop. More than one means something upstream is wrong and
  // guessing which to read would store a standard derived from the wrong document.
  const { data, error } = await supabase
    .from('strategy_documents')
    .select('id, content, icp_filter_spec, created_at')
    .eq('organisation_id', organisationId).eq('document_type', 'icp').eq('status', 'active')
  if (error) throw new Error(error.message)
  if (!data || data.length !== 1) throw new Error(`expected one active profile, read ${data?.length ?? 0}`)

  const doc = data[0]
  const spec = (doc.icp_filter_spec ?? null) as Record<string, unknown> | null
  if (!spec) throw new Error(`profile ${doc.id} has no settings to store conditions on.`)

  if (spec.fit_dimensions) {
    console.log(`${organisationId}: already has a stored list. Left alone; replacing it would move the standard under every run already measured against it.`)
    return
  }

  const statements = collectFitStatements(doc.content as IcpDocument)
  console.log(`${organisationId}: profile ${doc.id} (approved ${doc.created_at}), ${statements.length} statements read.`)

  const set = await deriveFitDimensions({ doc: doc.content as IcpDocument })
  for (const d of set.dimensions) {
    console.log(`  ${d.role.padEnd(10)} ${d.establishable ? 'establishable    ' : 'NOT establishable'}  ${d.key}`)
    console.log(`    ${d.statement}`)
  }
  const required = set.dimensions.filter(d => d.role === 'required').length
  const unestablishable = set.dimensions.filter(d => !d.establishable).length
  console.log(`  => ${set.dimensions.length} conditions, ${required} required, ${unestablishable} not establishable by research.`)

  if (!write) {
    console.log('  NOT STORED (dry run). Re-run with --write to store it.')
    return
  }

  // MERGED, NEVER REPLACED. The spread carries every other key of the settings through: an
  // update that sent only fit_dimensions would blank the search this client is sourced on.
  const { error: writeError } = await supabase
    .from('strategy_documents')
    .update({ icp_filter_spec: { ...spec, fit_dimensions: set } })
    .eq('id', doc.id)
  if (writeError) throw new Error(`write failed: ${writeError.message}`)

  // READ BACK. The effect of a write is read, never assumed, and the read checks that the rest
  // of the settings survived as well as that the list arrived.
  const { data: after, error: readError } = await supabase
    .from('strategy_documents').select('icp_filter_spec').eq('id', doc.id).single()
  if (readError || !after) throw new Error(`stored, but the read-back failed: ${readError?.message}`)

  const storedSpec = after.icp_filter_spec as Record<string, unknown>
  const stored = storedSpec.fit_dimensions as { dimensions?: unknown[] } | undefined
  const keysBefore = Object.keys(spec).sort().join(',')
  const keysAfter = Object.keys(storedSpec).filter(k => k !== 'fit_dimensions').sort().join(',')

  console.log(`  STORED: ${stored?.dimensions?.length ?? 0} conditions read back.`)
  console.log(`  settings keys intact: ${keysBefore === keysAfter ? 'yes' : `NO — before [${keysBefore}] after [${keysAfter}]`}`)
  if (keysBefore !== keysAfter) process.exit(1)
}

main().then(() => process.exit(0)).catch(e => { console.error('FAILED: ' + (e instanceof Error ? e.message : e)); process.exit(1) })
