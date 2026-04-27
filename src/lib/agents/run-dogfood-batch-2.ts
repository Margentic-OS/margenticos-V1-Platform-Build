// Dogfood batch 2 — re-run after tier model redesign (2026-04-27)
// Run with: npx tsx --env-file=.env.local src/lib/agents/run-dogfood-batch-2.ts
//
// Forces re-run of all 11 dogfood prospects (skip_existing=false) to validate
// the new icp_fit / has_dateable_signal / signal_observation / signal_relevance schema.
// Exports CSV to logs/batches/ after completion.

import fs from 'fs'
import path from 'path'
import { createClient } from '@supabase/supabase-js'
import { runProspectResearchAgentV2Batch } from '@/lib/agents/prospect-research-agent-v2'

const ORG_ID = '74243c62-f42d-4f3f-b93e-bd5e51f0b6c0'

// All 11 dogfood prospects excluding Ginny (she stays as isolated test subject).
const PROSPECT_IDS = [
  '0e62da2b-d274-4951-ae3f-6864d94a397d', // Anya Dayson         — Ascend Strategic Marketing
  '6e2a7510-a59b-469a-bb89-e341fbbc2268', // Julia Payne         — Fractional CMO Services
  '31658b02-6d92-44ef-b5ba-ef5b51f59b9f', // Simon Wakeman       — Team Wakeman
  '61d21418-fecc-4844-9589-7c317ed0c878', // Sue Belton          — Belton Executive Coaching
  'fb1c9554-101d-441f-9ec7-a3e6c980c74d', // Paul Davis          — Davis Business Consultants
  '941f68a5-f8be-4fb2-8bc9-77fd8a055249', // Helen Cox           — Helen Cox Marketing
  'e495c4d7-a155-4466-b4e0-1984ef56c3d2', // Jason Cornes        — Jason Cornes Business Coaching
  '247a2f3a-57b6-44bb-af0d-574030aa2a94', // Graeme Jordan       — STO Consulting
  'bb201be2-a324-4db4-ac75-5bf7710b50d6', // Aisling Foley       — Aisling Foley Marketing
  'bd8d6c79-4335-475e-a72d-e78a8c128336', // Sarah Abbott        — Abbott Consulting
  'b017fe7b-7731-4c44-8988-2da479dae5a4', // Julia Langkraehr    — Bold Clarity (was UTF-16 failure)
]

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Missing Supabase env vars')
  return createClient(url, key)
}

function escapeCsvField(value: string | null | undefined): string {
  if (value == null) return ''
  const str = String(value)
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

async function exportBatchCsv(batchStartedAt: string, outputPath: string): Promise<number> {
  const supabase = getServiceClient()

  const { data: rows, error } = await supabase
    .from('prospect_research_results')
    .select(`
      icp_fit,
      has_dateable_signal,
      signal_observation,
      signal_relevance,
      synthesis_confidence,
      qualification_status,
      qualification_reason,
      trigger_text,
      trigger_source,
      relevance_reason,
      synthesis_reasoning,
      synthesized_at,
      prospects!prospect_id (
        first_name,
        last_name,
        company_name
      )
    `)
    .eq('organisation_id', ORG_ID)
    .gte('synthesized_at', batchStartedAt)
    .order('synthesized_at', { ascending: true })

  if (error) throw new Error(`CSV export query failed: ${error.message}`)

  const columns = [
    'prospect_name',
    'company',
    'icp_fit',
    'has_dateable_signal',
    'signal_observation',
    'signal_relevance',
    'qualification_status',
    'qualification_reason',
    'confidence',
    'trigger_text',
    'trigger_source_url',
    'relevance_reason',
    'reasoning_chain',
    'researched_at',
  ]

  const csvRows: string[] = [columns.join(',')]

  for (const row of rows ?? []) {
    const prospectRaw = row.prospects
    const prospect = (Array.isArray(prospectRaw) ? prospectRaw[0] : prospectRaw) as {
      first_name: string | null
      last_name: string | null
      company_name: string | null
    } | null
    const triggerSource = row.trigger_source as { url?: string } | null

    csvRows.push([
      [prospect?.first_name, prospect?.last_name].filter(Boolean).join(' '),
      prospect?.company_name ?? '',
      row.icp_fit ?? '',
      row.has_dateable_signal != null ? String(row.has_dateable_signal) : '',
      row.signal_observation ?? '',
      row.signal_relevance ?? '',
      row.qualification_status ?? '',
      row.qualification_reason ?? '',
      row.synthesis_confidence ?? '',
      row.trigger_text ?? '',
      triggerSource?.url ?? '',
      row.relevance_reason ?? '',
      (row.synthesis_reasoning ?? '').replace(/\n/g, ' '),
      row.synthesized_at ?? '',
    ].map(escapeCsvField).join(','))
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, csvRows.join('\n'), 'utf8')
  return rows?.length ?? 0
}

async function main() {
  console.log('')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  Dogfood Batch 2 — tier model redesign validation')
  console.log(`  Prospects : ${PROSPECT_IDS.length}`)
  console.log(`  Org       : ${ORG_ID}`)
  console.log(`  Mode      : force re-run (skip_existing=false)`)
  console.log(`  Sources   : ${process.env.APIFY_API_KEY ? '✓ LinkedIn' : '✗ LinkedIn'} | Apollo | Website | Web Search`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('')

  const batchStartedAt = new Date().toISOString()

  const summary = await runProspectResearchAgentV2Batch({
    prospect_ids:       PROSPECT_IDS,
    client_id:          ORG_ID,
    skip_existing:      false,
    confirm_before_run: false,
    concurrency:        5,
  })

  console.log('')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  Batch complete — exporting CSV')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  const timestamp   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outputPath  = path.join(process.cwd(), 'logs', 'batches', `dogfood-batch-2-${timestamp}.csv`)
  const rowCount    = await exportBatchCsv(batchStartedAt, outputPath)

  console.log('')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  FINAL SUMMARY')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  Total prospects : ${summary.total}`)
  console.log(`  Completed       : ${summary.completed}`)
  console.log(`  Failed          : ${summary.failed}`)
  console.log(`  Skipped         : ${summary.skipped}`)
  if (summary.failed_log_path) {
    console.log(`  Failure log     : ${summary.failed_log_path}`)
  }
  console.log(`  CSV rows        : ${rowCount}`)
  console.log(`  CSV path        : ${outputPath}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('')

  if (summary.failures.length > 0) {
    console.log('  FAILURES:')
    for (const f of summary.failures) {
      console.log(`    ${f.prospect_id} — ${f.error}`)
    }
    console.log('')
  }
}

main().catch(err => {
  console.error('Batch runner crashed:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
