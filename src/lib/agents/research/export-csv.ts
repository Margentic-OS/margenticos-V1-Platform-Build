// CSV export for batch QA review.
// Usage: import { exportBatchResultsToCSV } from './research/export-csv'
//        const filePath = await exportBatchResultsToCSV({ batchId, clientId })
//        console.log('Written to:', filePath)

import fs from 'fs'
import path from 'path'
import { createClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('research/export-csv: missing Supabase env vars')
  return createClient(url, key)
}

function escapeCsvField(value: string | null | undefined): string {
  if (value == null) return ''
  const str = String(value)
  // Wrap in quotes if the value contains commas, quotes, or newlines.
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

const COLUMNS = [
  'prospect_name',
  'company',
  'tier',
  'confidence',
  'qualification_status',
  'trigger_text',
  'trigger_source_type',
  'trigger_source_url',
  'relevance_reason',
  'reasoning_chain',
  'researched_at',
]

export async function exportBatchResultsToCSV({
  batchId,
  clientId,
  outputPath,
}: {
  batchId: string
  clientId: string
  outputPath?: string
}): Promise<string> {
  const supabase = getServiceClient()

  const { data: rows, error } = await supabase
    .from('prospect_research_results')
    .select(`
      run_id,
      research_tier,
      synthesis_confidence,
      qualification_status,
      trigger_text,
      trigger_source,
      relevance_reason,
      synthesis_reasoning,
      synthesized_at,
      prospects (
        first_name,
        last_name,
        company_name
      )
    `)
    .eq('run_id', batchId)
    .eq('organisation_id', clientId)
    .order('synthesized_at', { ascending: true })

  if (error) throw new Error(`research/export-csv: query failed — ${error.message}`)
  if (!rows || rows.length === 0) {
    logger.warn('research/export-csv: no rows found', { batchId, clientId })
  }

  const csvRows: string[] = [COLUMNS.join(',')]

  for (const row of rows ?? []) {
    const prospectRaw = row.prospects
    const prospect = (Array.isArray(prospectRaw) ? prospectRaw[0] : prospectRaw) as { first_name: string | null; last_name: string | null; company_name: string | null } | null
    const triggerSource = row.trigger_source as { type?: string; url?: string } | null

    const prospectName = [prospect?.first_name, prospect?.last_name].filter(Boolean).join(' ') || ''
    const company      = prospect?.company_name ?? ''
    const tier         = row.research_tier ?? ''
    const confidence   = row.synthesis_confidence ?? ''
    const status       = row.qualification_status ?? ''
    const triggerText  = row.trigger_text ?? ''
    const sourceType   = triggerSource?.type ?? ''
    const sourceUrl    = triggerSource?.url ?? ''
    const relevance    = row.relevance_reason ?? ''
    const reasoning    = (row.synthesis_reasoning ?? '').replace(/\n/g, ' ')
    const researchedAt = row.synthesized_at ?? ''

    csvRows.push([
      prospectName,
      company,
      tier,
      confidence,
      status,
      triggerText,
      sourceType,
      sourceUrl,
      relevance,
      reasoning,
      researchedAt,
    ].map(escapeCsvField).join(','))
  }

  const csvContent = csvRows.join('\n')

  const timestamp  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const defaultOut = path.join('/tmp', `research-qa-${batchId.slice(0, 8)}-${timestamp}.csv`)
  const filePath   = outputPath ?? defaultOut

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, csvContent, 'utf8')

  logger.info('research/export-csv: written', { path: filePath, rows: rows?.length ?? 0 })
  return filePath
}
