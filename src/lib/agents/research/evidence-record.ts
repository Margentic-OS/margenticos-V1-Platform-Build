// Which research record holds the evidence for a prospect.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE DEFECT THIS CLOSES
//
// A reuse run writes a research row whose sources are marked skipped, carries an earlier
// row's findings and verdict forward, and makes that row the prospect's current one. On
// 2026-08-20 one batch did that to twelve prospects, all later uploaded: their current row
// holds no evidence, while the full row written seven hours earlier still does. Anything that
// judged the prospect from the current row judged it from nothing.
//
// So a reader that needs EVIDENCE asks for the newest row that holds some, never simply the
// newest row. current_research_result_id is left exactly as it is: it records which run last
// touched the prospect, and nothing here writes.

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  RawSourceData, LinkedInSourceResult, ApolloSourceResult, WebsiteSourceResult, WebSearchSourceResult,
} from './types'

/** How many of a prospect's research rows are examined. The most on record is 23. */
const EVIDENCE_SCAN_LIMIT = 50

export interface EvidenceRecord {
  id:                 string
  created_at:         string
  sources_successful: string[]
  raw:                RawSourceData
}

/** True when a research row fetched at least one source successfully. */
export function holdsEvidence(sourcesSuccessful: unknown): boolean {
  return Array.isArray(sourcesSuccessful) && sourcesSuccessful.length > 0
}

// A stored raw_* column is the full source result, or only { error } when the source was
// unavailable (see storeResearchResult). Either way it becomes a complete result here.
function source<T extends { available: boolean }>(stored: unknown, empty: T): T {
  if (!stored || typeof stored !== 'object') return empty
  const value = stored as Record<string, unknown>
  return { ...empty, ...value, available: value.available === true } as T
}

/**
 * The newest research row for this prospect, in this organisation, that holds evidence.
 * null when none does. Throws on a query fault: "could not look" and "nothing on file" are
 * different answers, and a grader must not quietly treat the first as the second.
 */
export async function loadEvidenceRecord(
  supabase: SupabaseClient,
  prospect_id: string,
  client_id: string,
): Promise<EvidenceRecord | null> {
  const { data, error } = await supabase
    .from('prospect_research_results')
    .select('id, created_at, sources_successful, raw_linkedin, raw_apollo, raw_website, raw_web_search')
    .eq('prospect_id', prospect_id)
    .eq('organisation_id', client_id)
    .order('created_at', { ascending: false })
    .limit(EVIDENCE_SCAN_LIMIT)

  if (error) throw new Error(`evidence lookup failed for prospect ${prospect_id}: ${error.message}`)

  const row = (data ?? []).find(r => holdsEvidence(r.sources_successful))
  if (!row) return null

  return {
    id:                 row.id as string,
    created_at:         row.created_at as string,
    sources_successful: row.sources_successful as string[],
    raw: {
      linkedin:   source<LinkedInSourceResult>(row.raw_linkedin, { available: false, profile_data: null, recent_posts: null, formatted: null }),
      apollo:     source<ApolloSourceResult>(row.raw_apollo, { available: false, formatted: null, raw: null }),
      website:    source<WebsiteSourceResult>(row.raw_website, { available: false, url: null, content: null, fetch_method: null }),
      web_search: source<WebSearchSourceResult>(row.raw_web_search, { available: false, person_search: null, company_search: null, combined: null } as WebSearchSourceResult),
    },
  }
}
