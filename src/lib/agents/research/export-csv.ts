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
    const triggerSource = row.trigger_source as { url?: string } | null

    const prospectName   = [prospect?.first_name, prospect?.last_name].filter(Boolean).join(' ') || ''
    const company        = prospect?.company_name ?? ''
    const icpFit         = row.icp_fit ?? ''
    const dateableSignal = row.has_dateable_signal != null ? String(row.has_dateable_signal) : ''
    const signalObs      = row.signal_observation ?? ''
    const signalRel      = row.signal_relevance ?? ''
    const status         = row.qualification_status ?? ''
    const qualReason     = row.qualification_reason ?? ''
    const confidence     = row.synthesis_confidence ?? ''
    const triggerText    = row.trigger_text ?? ''
    const sourceUrl      = triggerSource?.url ?? ''
    const relevance      = row.relevance_reason ?? ''
    const reasoning      = (row.synthesis_reasoning ?? '').replace(/\n/g, ' ')
    const researchedAt   = row.synthesized_at ?? ''

    csvRows.push([
      prospectName,
      company,
      icpFit,
      dateableSignal,
      signalObs,
      signalRel,
      status,
      qualReason,
      confidence,
      triggerText,
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
