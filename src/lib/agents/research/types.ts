// Types for prospect research agent v2.
// All source handlers and the synthesizer use these interfaces.

export type IcpFit = 'strong' | 'moderate' | 'weak'

// use_as_hook  — a candidate passed all six tests; safe to reference directly in the opener
// mention_only — passed SPECIFIC + VERIFIABLE + RELEVANT but not all six; usable as context, not as a hook
// no_signal    — nothing cleared the bar; the ICP pain trigger is used instead
// ignore       — legacy value, retained because it is the column default and pre-dates
//                candidate generation. Treated identically to no_signal by every consumer.
export type SignalRelevance = 'use_as_hook' | 'mention_only' | 'no_signal' | 'ignore'

// ─── Candidate observations (FIX A) ──────────────────────────────────────────
// The synthesis step generates MULTIPLE candidate observations from all raw material
// and scores each against six tests, rather than evaluating a single pre-selected item.
// Every candidate is persisted so the rejected ones are inspectable, not just the winner.

export type CandidateSource = 'linkedin' | 'apollo' | 'website' | 'web_search' | 'composite'

export interface CandidateScores {
  /** Names a thing, a date, or a number, not a category. */
  specific: boolean
  /** Confirmable by a human in 30 seconds from the cited source. */
  verifiable: boolean
  /** Implies something the prospect would agree with, beyond the fact. */
  inferential: boolean
  /** Connects to pipeline, marketing capacity, or client acquisition. Otherwise trivia. */
  relevant: boolean
  /** Tells the prospect something, or frames something they had not articulated. */
  useful: boolean
  /** Reads as noticing, not as scoring their performance. */
  non_judgemental: boolean
}

export const SIX_TESTS = [
  'specific', 'verifiable', 'inferential', 'relevant', 'useful', 'non_judgemental',
] as const

export interface ObservationCandidate {
  /** Stable id within this run: c1, c2, ... */
  id: string
  /** The observation itself, as it would be referenced. */
  observation: string
  source: CandidateSource
  /**
   * Where a human verifies this in 30 seconds: a URL, or an exact location
   * ("Apollo employment_history entry 2", "LinkedIn post dated 2026-07-20").
   * An observation without provenance fails VERIFIABLE by definition.
   */
  provenance: string
  /** ISO date or approximate date string. null when the observation is undated. */
  date: string | null
  /** True when the candidate combines several smaller items into one pattern. */
  is_composite: boolean
  scores: CandidateScores
  /** Derived in code from scores, never trusted from the model. */
  passes_all: boolean
  /** Count of passed tests, 0-6. Derived in code. */
  score_total: number
  /** Why it was not selected. null for the winner. */
  rejection_reason: string | null
}
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
  icp_fit:             IcpFit
  has_dateable_signal: boolean
  signal_observation:  string | null
  signal_relevance:    SignalRelevance
  qualification_status:  QualificationStatus
  qualification_reason:  string | null
  confidence:            SynthesisConfidence
  trigger_text:          string
  trigger_source:        TriggerSource | null  // null going forward; kept for DB compat
  relevance_reason:      string
  reasoning:             string
  /** Every candidate considered, winner included, with its six-test scores. */
  candidates:            ObservationCandidate[]
  /** id of the selected candidate, or null when nothing cleared the bar. */
  selected_candidate_id: string | null
}

// Stripped-down prospect shape passed to all source handlers and the synthesizer.
export interface ProspectContext {
  id: string
  organisation_id: string
  /** Segment this prospect belongs to. Used to fetch the correct ICP for scoring. */
  segment_id: string | null
  first_name: string | null
  last_name: string | null
  company_name: string | null
  role: string | null
  email: string | null
  linkedin_url: string | null
  website_url: string | null
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
  icp_fit: IcpFit
  has_dateable_signal: boolean
  signal_observation: string | null
  signal_relevance: SignalRelevance
  qualification_status: QualificationStatus
  qualification_reason: string | null
  trigger_text: string
  trigger_source: TriggerSource | null
  relevance_reason: string
  synthesis_confidence: SynthesisConfidence
  synthesis_reasoning: string
  sources_attempted: string[]
  sources_successful: string[]
  candidates: ObservationCandidate[]
  selected_candidate_id: string | null
}

export interface ResearchInput {
  prospect_id: string
  client_id: string
}

export interface ResearchBatchInput {
  prospect_ids: string[]
  client_id: string
  skip_existing?: boolean
  confirm_before_run?: boolean  // default true; set false for programmatic/test use under 10 prospects
  concurrency?: number          // max simultaneous prospect calls; default 5 (Apollo/Brave rate limit ceiling)
}

export interface ResearchBatchFailure {
  prospect_id: string
  error: string
}

export interface ResearchBatchSummary {
  total: number
  completed: number
  skipped: number
  failed: number
  failures: ResearchBatchFailure[]
  failed_log_path: string | null
}
