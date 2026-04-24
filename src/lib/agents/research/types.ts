// Types for prospect research agent v2.
// All source handlers and the synthesizer use these interfaces.

export type ResearchTier = 'tier1' | 'tier3'
export type QualificationStatus = 'qualified' | 'flagged_for_review' | 'disqualified'
export type SynthesisConfidence = 'high' | 'medium' | 'low'
export type TriggerSourceType =
  | 'linkedin_post'
  | 'podcast'
  | 'article'
  | 'case_study'
  | 'company_content'
  | 'icp_pain_proxy'

export interface TriggerSource {
  type: TriggerSourceType
  url: string | null
  date: string | null
  description: string
}

export interface SynthesisOutput {
  tier: ResearchTier
  qualification_status: QualificationStatus
  qualification_reason: string | null
  confidence: SynthesisConfidence
  trigger_text: string
  trigger_source: TriggerSource | null
  relevance_reason: string
  reasoning: string
}

// Stripped-down prospect shape passed to all source handlers and the synthesizer.
export interface ProspectContext {
  id: string
  organisation_id: string
  first_name: string | null
  last_name: string | null
  company_name: string | null
  role: string | null
  email: string | null
  linkedin_url: string | null
}

export interface LinkedInSourceResult {
  available: boolean
  profile_data: Record<string, unknown> | null
  recent_posts: Array<Record<string, unknown>> | null
  formatted: string | null
  error?: string
}

export interface ApolloSourceResult {
  available: boolean
  formatted: string | null
  raw: Record<string, unknown> | null
  error?: string
}

export interface WebsiteSourceResult {
  available: boolean
  url: string | null
  content: string | null
  fetch_method: 'direct' | 'jina' | null
  error?: string
}

export interface WebSearchSourceResult {
  available: boolean
  person_search: string | null
  company_search: string | null
  combined: string | null
  error?: string
}

export interface RawSourceData {
  linkedin: LinkedInSourceResult
  apollo: ApolloSourceResult
  website: WebsiteSourceResult
  web_search: WebSearchSourceResult
}

export interface ResearchResult {
  prospect_id: string
  client_id: string
  research_result_id: string
  tier: ResearchTier
  qualification_status: QualificationStatus
  qualification_reason: string | null
  trigger_text: string
  trigger_source: TriggerSource | null
  relevance_reason: string
  synthesis_confidence: SynthesisConfidence
  synthesis_reasoning: string
  sources_attempted: string[]
  sources_successful: string[]
}

export interface ResearchInput {
  prospect_id: string
  client_id: string
}

export interface ResearchBatchInput {
  prospect_ids: string[]
  client_id: string
  skip_existing?: boolean
}

export interface ResearchBatchSummary {
  total: number
  completed: number
  skipped: number
  failed: number
}
