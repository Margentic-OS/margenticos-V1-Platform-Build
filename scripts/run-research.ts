#!/usr/bin/env npx tsx
/**
 * Run prospect research for one organisation, from the command line.
 *
 * Run with:
 *   npx tsx --env-file=.env.local scripts/run-research.ts --org <uuid> --scope unresearched
 *
 * This calls the SAME entry point the operator dashboard calls
 * (src/lib/operator/research-batch-entry.ts), so a run from here and a click in the
 * dashboard make identical decisions about caps, archived organisations, concurrent runs
 * and overwriting finished copy.
 *
 * It replaces src/lib/agents/run-dogfood-batch-2.ts, which hardcoded one organisation id
 * and eleven prospect ids. Nothing is hardcoded here.
 *
 * WHAT THIS CAN DO THAT THE DASHBOARD CANNOT
 *
 *   --allow-overwrite-trigger
 *     Researching a prospect that already has a personalisation trigger REPLACES that copy
 *     with newly generated wording, and CLEARS it outright when the judge holds. That is a
 *     legitimate thing to want and a bad thing to do by accident, so it lives behind this
 *     flag and no dashboard control can set it. If the copy has already been sent, the
 *     stored record will no longer match what the prospect received.
 *
 *   --fresh
 *     Fetches all four sources again instead of reusing findings already on file. This is
 *     the expensive half of a run. The default reuses, deliberately: on 2026-08-20 the old
 *     fetch-always default turned 13 prospects into 176 research runs and 22 USD in one day.
 */

import { createClient } from '@supabase/supabase-js'
import {
  runResearchBatchForOrg,
  RESEARCH_MAX_PROSPECTS,
  type ResearchScope,
} from '@/lib/operator/research-batch-entry'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function usage(message: string): never {
  console.error(`\n${message}\n`)
  console.error('Usage:')
  console.error('  npx tsx --env-file=.env.local scripts/run-research.ts --org <uuid> [options]')
  console.error('')
  console.error('  --org                       organisation id. Required. Must not be archived.')
  console.error('  --scope                     unresearched (default) or researched.')
  console.error('  --ids                       comma-separated prospect ids. Overrides --scope.')
  console.error('  --fresh                     fetch every source again instead of reusing findings on file.')
  console.error('  --allow-overwrite-trigger   permit overwriting copy that already exists. Read the header.')
  console.error('')
  console.error(`  At most ${RESEARCH_MAX_PROSPECTS} prospects per run, and fewer when sources must be fetched.`)
  console.error('')
  process.exit(1)
}

async function main() {
  const orgId = arg('org')
  if (!orgId) usage('Missing --org.')

  const scopeRaw = arg('scope') ?? 'unresearched'
  if (scopeRaw !== 'unresearched' && scopeRaw !== 'researched') {
    usage(`--scope must be unresearched or researched, got "${scopeRaw}".`)
  }
  const scope = scopeRaw as ResearchScope

  const idsRaw = arg('ids')
  const prospectIds = idsRaw
    ? idsRaw.split(',').map(s => s.trim()).filter(Boolean)
    : undefined

  const useStoredFindings = !flag('fresh')
  const allowOverwriteTrigger = flag('allow-overwrite-trigger')

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) usage('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. Pass --env-file=.env.local.')
  if (!process.env.ANTHROPIC_API_KEY) usage('ANTHROPIC_API_KEY must be set.')

  const supabase = createClient(url, key)

  const { data: org } = await supabase
    .from('organisations')
    .select('name')
    .eq('id', orgId)
    .single()

  console.log('')
  console.log('  Research run')
  console.log(`  Organisation : ${org?.name ?? 'unknown'} (${orgId})`)
  console.log(`  Selection    : ${prospectIds ? `${prospectIds.length} explicit ids` : scope}`)
  console.log(`  Sources      : ${useStoredFindings ? 'reuse findings on file where available' : 'FETCH EVERY SOURCE'}`)
  if (allowOverwriteTrigger) {
    console.log('  OVERWRITE    : ON. Existing personalisation copy will be replaced or cleared.')
  }
  console.log('  Calls the Anthropic API. Costs real money.')
  console.log('')

  const result = await runResearchBatchForOrg({
    supabase,
    organisation_id: orgId,
    scope,
    prospect_ids: prospectIds,
    use_stored_findings: useStoredFindings,
    allow_overwrite_trigger: allowOverwriteTrigger,
  })

  if (!result.ok) {
    console.error('')
    console.error(`  REFUSED OR FAILED: ${result.error}`)
    console.error('')
    process.exit(1)
  }

  const s = result.summary

  console.log('')
  console.log(`  Selected            : ${result.prospects_selected}`)
  console.log(`  Completed           : ${s.completed}`)
  console.log(`  Failed              : ${s.failed}`)
  console.log(`  Skipped             : ${s.skipped}`)
  console.log(`  Distinct questions  : ${s.distinct_questions}`)
  console.log(`  Abstract noun hits  : ${s.abstract_noun_total} (report only)`)

  if (s.bridge_frame_collisions.length > 0 || s.question_collisions.length > 0) {
    console.log('')
    console.log(`  GATE DEFECT: ${s.bridge_frame_collisions.length} repeated bridges, ${s.question_collisions.length} repeated questions.`)
    console.log('  These should be zero. A non-empty count means the uniqueness gate failed.')
  }

  if (s.failures.length > 0) {
    console.log('')
    console.log('  FAILURES:')
    for (const f of s.failures) {
      console.log(`    ${f.prospect_id} — ${f.error}`)
    }
  }

  console.log('')
}

main().catch(err => {
  console.error('Research run crashed:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
