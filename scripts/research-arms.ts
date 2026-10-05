#!/usr/bin/env npx tsx
/**
 * The research arms, from the command line: the comparison Doug approves from, and the approval.
 *
 *   npx tsx --env-file=.env.local scripts/research-arms.ts report --org <uuid> [--batch <uuid>]
 *   npx tsx --env-file=.env.local scripts/research-arms.ts approve --org <uuid> --batch <uuid> --yes
 *
 * report   Reads only. Both arms side by side: researches, personalised share, tier split, fit-grade
 *          distribution, cost per research, cost per 100 and cost per personalised email, and how many
 *          short_reasoning prospects are still held at upload. --batch limits it to one Anthropic batch.
 *
 * approve  Releases the short_reasoning prospects of ONE batch from the upload hold. Writes only with
 *          --yes, and prints the report it is approving first. Releasing is what lets those prospects
 *          be uploaded, so it is never run by default. Approval is per batch: a later batch is held
 *          until it is approved in its own right.
 *
 * split    Turns the 50/50 split on or off for one organisation (organisations.research_arm_split_enabled).
 *          OFF is the default and means every new prospect is standard. ON means the next batch
 *          assigns arms. Turning it on changes what research runs next, so it is an explicit
 *          --set on|off, and it prints the switch before and after. It touches no prospect.
 *
 * None of these calls the model or spends anything.
 */

import { createClient } from '@supabase/supabase-js'
import { releaseShortReasoningBatch } from '@/lib/agents/research/research-arm-store'
import { loadArmReport, type ArmReportLine } from '@/lib/operator/research-arm-report'

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
  console.error('  npx tsx --env-file=.env.local scripts/research-arms.ts report --org <uuid> [--batch <uuid>]')
  console.error('  npx tsx --env-file=.env.local scripts/research-arms.ts approve --org <uuid> --batch <uuid> --yes')
  console.error('  npx tsx --env-file=.env.local scripts/research-arms.ts split --org <uuid> --set on|off')
  console.error('')
  process.exit(1)
}

const pct = (x: number | null) => (x === null ? '  n/a' : `${(x * 100).toFixed(0).padStart(4)}%`)
const usd = (x: number | null, digits = 4) => (x === null ? 'n/a' : `$${x.toFixed(digits)}`)
const counts = (c: Record<string, number>) =>
  Object.entries(c).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}:${v}`).join('  ') || '(none)'

function printLine(line: ArmReportLine) {
  const label = line.arm === 'short_reasoning' ? 'short_reasoning (arm A)' : 'standard'
  console.log(`  ${label}`)
  console.log(`    researches              : ${line.researches}`)
  console.log(`    personalised            : ${line.personalised} (${pct(line.personalisedShare)})`)
  console.log(`    tier split              : ${counts(line.tiers)}`)
  console.log(`    fit grades              : ${counts(line.fitGrades)}`)
  console.log(`    cost per research       : ${usd(line.usdPerResearch)}   (${line.costed} costed, ${line.unpriced} unpriced)`)
  console.log(`    cost per 100            : ${usd(line.usdPer100, 2)}`)
  console.log(`    cost per personalised   : ${usd(line.usdPerPersonalised, 4)}`)
  console.log('')
}

async function main() {
  const [subcommand] = process.argv.slice(2)
  if (subcommand !== 'report' && subcommand !== 'approve' && subcommand !== 'split') {
    usage('Name a subcommand: report, approve or split.')
  }

  const orgId = arg('org')
  if (!orgId) usage('Missing --org.')
  const batchId = arg('batch')
  if (subcommand === 'approve' && !batchId) usage('approve needs --batch: approval is per batch.')

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) usage('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. Pass --env-file=.env.local.')
  const supabase = createClient(url, key)

  if (subcommand === 'split') {
    const setRaw = arg('set')
    if (setRaw !== 'on' && setRaw !== 'off') usage('split needs --set on or --set off.')
    const { data: before, error: readError } = await supabase
      .from('organisations').select('name, research_arm_split_enabled').eq('id', orgId).is('archived_at', null).maybeSingle()
    if (readError) throw new Error(`could not read the organisation: ${readError.message}`)
    if (!before) usage(`Organisation ${orgId} not found or archived.`)
    const wanted = setRaw === 'on'
    console.log('')
    console.log(`  Organisation : ${before.name} (${orgId})`)
    console.log(`  Split before : ${before.research_arm_split_enabled === true ? 'ON' : 'OFF'}`)
    const { error } = await supabase.from('organisations').update({ research_arm_split_enabled: wanted }).eq('id', orgId)
    if (error) throw new Error(`could not write the switch: ${error.message}`)
    console.log(`  Split after  : ${wanted ? 'ON' : 'OFF'}. The next batch ${wanted ? 'assigns arms 50/50' : 'runs standard for everyone'}.`)
    console.log('')
    return
  }

  const { data: org } = await supabase.from('organisations').select('name, research_arm_split_enabled').eq('id', orgId).maybeSingle()
  console.log('')
  console.log(`  Organisation        : ${org?.name ?? 'UNKNOWN'} (${orgId})`)
  console.log(`  Split switch        : ${org?.research_arm_split_enabled === true ? 'ON' : 'OFF'}`)
  console.log(`  Batch               : ${batchId ?? 'all batches'}`)
  console.log('')

  const { report, heldShortReasoning } = await loadArmReport(supabase, orgId, batchId)
  printLine(report.standard)
  printLine(report.short_reasoning)
  console.log(`  Held at upload (short_reasoning, not released, all batches): ${heldShortReasoning}`)
  console.log('')

  if (subcommand === 'report') return

  if (!flag('yes')) {
    console.log('  Not approved. This shows the comparison only. Add --yes to release the short_reasoning')
    console.log(`  prospects of batch ${batchId} from the upload hold.`)
    console.log('')
    return
  }

  const result = await releaseShortReasoningBatch(supabase, orgId, batchId as string)
  console.log(`  APPROVED. Batch ${batchId}: ${result.prospectsInBatch} prospects in the batch, ${result.released} released from the hold.`)
  console.log('  Released prospects are uploaded by the normal upload path, under the usual gate.')
  console.log('')
}

main().catch(err => {
  console.error('research-arms failed:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
