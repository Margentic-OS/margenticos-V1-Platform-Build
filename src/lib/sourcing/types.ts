import type { ICPFilterSpec } from '@/lib/agents/icp-filter-spec'

// Trigger types for sourcing runs per PRD-15
export type SourcingTriggerType = 'inventory_monitor' | 'operator_manual'

// Prospect shape after sourcing (normalised per PRD-15 step 4)
export interface ProspectCandidate {
  first_name: string | null
  last_name: string | null
  email: string | null
  company_name: string | null
  role: string | null
  linkedin_url: string | null
  website_url: string | null
  company_country?: string
  person_country?: string
  company_headcount?: number
  research_source: string
  personalisation_trigger: string | null
  trigger_confidence: string | null
}

// Sourcing handler interface (implemented per tool)
export interface SourcingHandler {
  // List of fields this handler can filter/search on
  // Keys must match FILTER_FIELDS entries that this handler supports
  supported_fields: string[]
  // Translate spec to API-specific format and execute search
  // (Actual implementation provided by adapter-apollo, etc.)
  execute?: (spec: ICPFilterSpec, batchSize: number) => Promise<ProspectCandidate[]>
}

// Result of a sourcing run
export interface SourcingRunResult {
  organisation_id: string
  trigger_type: SourcingTriggerType
  candidates_sourced: number
  candidates_qualified: number
  run_timestamp: string
  error?: string
}

// Filter fields that can be searched/filtered.
// Meta fields (notes, unmatched_industries) are excluded — manifest check applies only to these.
// If a field in the spec has a non-empty value, the manifest check verifies the handler supports it.
export const FILTER_FIELDS = [
  'job_titles',
  'job_titles_excluded',
  'seniority_levels',
  'departments',
  'person_countries',
  'company_countries',
  'company_headcount_min',
  'company_headcount_max',
  'industries',
  'industries_excluded',
  'keywords',
  'keywords_excluded',
] as const

// Re-export ICPFilterSpec from the canonical location
export type { ICPFilterSpec } from '@/lib/agents/icp-filter-spec'
