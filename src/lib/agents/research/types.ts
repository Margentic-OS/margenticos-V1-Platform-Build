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

// ─── Inference direction (FIX 4) ─────────────────────────────────────────────
// A candidate can pass all six tests while the CONCLUSION drawn from its evidence is
// backwards. "Robert's CRC role ended, so he needs pipeline" reads the same facts as
// "Robert left CRC because Taffet got busy". VERIFIABLE only ever checked the underlying
// FACT, never the direction of the inference, so this is a distinct failure with a
// distinct field rather than a tightening of an existing test.
//
// only_reading:         the evidence genuinely supports one reading. The opposite is
//                        implausible and the model said why.
// compatible_with_both: both readings are plausible AND the observation is phrased so
//                        the email works either way. Safe to use as a hook.
// ambiguous_unhandled:  both readings are plausible and the observation commits to one.
//                        Demoted: never used as a hook.
export type InferenceDirection = 'only_reading' | 'compatible_with_both' | 'ambiguous_unhandled'

export const INFERENCE_DIRECTIONS = [
  'only_reading', 'compatible_with_both', 'ambiguous_unhandled',
] as const

/** Deterministic readability verdict attached to a candidate. Mirrors ReadabilityScore. */
export interface CandidateReadability {
  /** Unambiguous rule broken: sentence over the word cap, or a hedge phrase. Gates selection. */
  hard_fail: boolean
  /** Demerits, lower is better. Ranks candidates that all clear the hard gate. */
  penalty: number
  /** Word count of the longest sentence. */
  max_sentence_words: number
  /** Hedge phrases found. */
  hedges: string[]
  /** Nominalisation density, 0-1. Penalty only, never a hard fail. */
  nominalisation_density: number
  /** True when density exceeded the threshold. Contributes demerits only. */
  nominalisation_over_threshold: boolean
  /** Plain-English reasons, one per problem. */
  reasons: string[]
}

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
  /**
   * The model's own readable verdict. ADVISORY ONLY, kept so a disagreement between the
   * model and the measurement is inspectable. `readability` below is what gates.
   */
  model_readable_claim: boolean
  /**
   * The opposite reading of this candidate's own evidence, stated by the model.
   * null when the model failed to supply one, which is itself a demotion reason.
   */
  opposite_reading: string | null
  /** How the opposite reading was handled. Derived in code from the model's claim. */
  inference_direction: InferenceDirection
  /** Deterministic readability verdict. Computed in code, never read from the model. */
  readability: CandidateReadability
  /**
   * True when the candidate cleared all six tests but was blocked from hook use by a
   * readability hard fail or an unhandled inference ambiguity.
   */
  demoted: boolean
  /** Why it was demoted or not selected. null for the winner. */
  rejection_reason: string | null
}
export type QualificationStatus = 'qualified' | 'flagged_for_review' | 'disqualified'
export type SynthesisConfidence = 'high' | 'medium' | 'low'
export type TriggerSourceType =
  // ── The values written since 2026-08-24 ──
  //
  // These are CandidateSource values, recorded verbatim rather than mapped into the
  // legacy vocabulary below. The question trigger_source has to answer is "which PAID
  // source produced the opener we shipped", and only these names answer it: they are the
  // four fetchers plus the composite case. Mapping 'apollo' or 'web_search' into
  // 'article' or 'company_content' would destroy exactly the distinction being measured.
  | 'linkedin'
  | 'apollo'
  | 'website'
  | 'web_search'
  | 'composite'
  // ── Legacy, kept only so rows written before 2026-08-24 still typecheck ──
  //
  // Nothing writes these now. They described the KIND of artefact rather than the source
  // that fetched it, which is a different question and not the one that decides whether a
  // paid source earns its cost.
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
  /**
   * What the one synthesis call cost. ZERO on the stored-findings path, which makes no
   * call at all, and that zero is a fact rather than a missing measurement.
   *
   * Every producer here defaults it to zero and synthesizeResearch overwrites it with the
   * measured value on the single return that has the response in hand. That keeps the
   * fallback and parse paths from having to carry a number they cannot know.
   */
  usage:               TokenUsage
  icp_fit:             IcpFit
  has_dateable_signal: boolean
  signal_observation:  string | null
  signal_relevance:    SignalRelevance
  qualification_status:  QualificationStatus
  qualification_reason:  string | null
  confidence:            SynthesisConfidence
  /**
   * The personalisation hook, or NULL when no candidate was selected.
   * NULL is meaningful: composition treats any non-null personalisation_trigger as a
   * researched observation, so writing a proxy here replaces the variant's authored
   * opener with generic text. Only a real observation belongs in this field.
   */
  trigger_text:          string | null
  /**
   * The ICP pain proxy that WOULD have been used. Recorded on the research result row
   * for audit, never written to prospects.personalisation_trigger.
   */
  icp_pain_proxy:        string | null
  /**
   * Which source produced the winning candidate. Populated from 2026-08-24.
   *
   * Was hardcoded null from 2026-08-19 to 2026-08-24, leaving 224 rows with no record of
   * which paid source earned its keep. sources_attempted and sources_successful say what
   * RAN, which is a different and much weaker question than what WON.
   */
  trigger_source:        TriggerSource | null
  relevance_reason:      string
  reasoning:             string
  /** Every candidate considered, winner included, with its six-test scores. */
  candidates:            ObservationCandidate[]
  /** id of the selected candidate, or null when nothing cleared the bar. */
  selected_candidate_id: string | null
  /** Deterministic readability verdict on trigger_text, the string that reaches the email. */
  trigger_readability:   CandidateReadability
  /**
   * Set when signal_relevance was downgraded after the model produced it: an unreadable
   * trigger, or a winner whose inference direction was unhandled. null when nothing was
   * downgraded.
   */
  demotion_reason:       string | null
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
  /**
   * The SOURCED job title, and the one the writer and the judge are briefed with.
   *
   * SEPARATE FROM `role` ON PURPOSE, because they are separate columns with separate
   * writers. `prospects.job_title` is what the sourcing orchestrator writes; `prospects.role`
   * is only ever written by the old research agent and is NULL for every sourced prospect.
   * Measured 2026-08-29: role populated on 1 of 48 prospects, job_title on 29 of 48.
   *
   * The same wrong-column read has already been found and fixed twice outside research,
   * once where it sent no job title at all to the outbound provider and once in the tier
   * review UI. Research was the third instance.
   */
  job_title: string | null
  email: string | null
  linkedin_url: string | null
  website_url: string | null
}

/**
 * What a set of Anthropic calls actually cost, in tokens.
 *
 * Added 2026-08-25. Before this the per-prospect cost model was built from character
 * counts at ~4 chars/token, self-rated at plus or minus 20%, and it omitted native web
 * search entirely. Every response already carried these four numbers and every call site
 * threw them away.
 *
 * `calls` is here because the writer runs 1 to 3 times per prospect and floor and judge
 * run 0 to 3 times each. Without it a token total cannot be read back as a per-call
 * figure, and the retry path is exactly where the interesting spend is.
 */
export interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  calls: number
}

export const ZERO_TOKEN_USAGE: TokenUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  calls: 0,
}

/** Sums usage across calls. Absent fields count as zero, never as unknown. */
export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input_tokens:                a.input_tokens + b.input_tokens,
    output_tokens:               a.output_tokens + b.output_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
    cache_read_input_tokens:     a.cache_read_input_tokens + b.cache_read_input_tokens,
    calls:                       a.calls + b.calls,
  }
}

/** Reads the SDK's usage object into ours. Null and undefined become zero. */
export function readTokenUsage(usage: {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
} | null | undefined): TokenUsage {
  return {
    input_tokens:                usage?.input_tokens ?? 0,
    output_tokens:               usage?.output_tokens ?? 0,
    cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens:     usage?.cache_read_input_tokens ?? 0,
    calls:                       1,
  }
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
  /**
   * WHICH PROVIDER ANSWERED, and what it cost. Stored into prospect_research_results
   * .raw_web_search, which is jsonb, so this needs no migration.
   *
   * Added 2026-08-25 because neither question could be answered from stored data. On the
   * 209 search texts on file there is no provider field at all, so "is Brave worse than
   * native" had to be inferred from the SHAPE of the prose and came out as n=2. And the
   * per-search billing was invisible, so the native path sat at $0 in the cost estimator
   * while plausibly being the second-largest Anthropic line.
   *
   * Both queries are summed. Per-query detail is not worth a schema.
   */
  providers: readonly ('anthropic_native' | 'brave' | 'none')[]
  /** Total BILLABLE searches across both queries. The cost unit. */
  search_count: number
  /** Total hits returned across both queries. The quality unit. */
  result_count: number
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
  trigger_text: string | null
  /**
   * The two halves of trigger_text, which is now two paragraphs. Kept apart so the batch
   * can verify after the run that no two shipped bridges share a sentence shape, without
   * re-splitting stored prose to find the boundary.
   */
  bridge_text: string | null
  question_text: string | null
  trigger_source: TriggerSource | null
  relevance_reason: string
  synthesis_confidence: SynthesisConfidence
  synthesis_reasoning: string
  sources_attempted: string[]
  sources_successful: string[]
  candidates: ObservationCandidate[]
  selected_candidate_id: string | null
  trigger_readability: CandidateReadability
  demotion_reason: string | null
  /**
   * Every Anthropic token this prospect spent: the synthesis call plus every writer, floor
   * and judge call across all attempts. Written to job_queue.spend_detail by the research
   * executor, which is the only place a per-prospect cost can be read back later.
   */
  token_usage: TokenUsage
  /** Billable web searches this prospect ran. Zero on a stored-findings reuse. */
  web_search_count: number
}

export interface ResearchInput {
  prospect_id: string
  client_id: string
  /**
   * Skip source gathering and reuse the findings already stored for this prospect.
   *
   * First half of the caching work in BACKLOG. Sources are the expensive and fragile part
   * of a run: LinkedIn costs real money per call and degrades SILENTLY when the Apify
   * balance is empty, which on 2026-08-20 produced thirteen openings written without any
   * LinkedIn data while every log line still read as success. Re-running the writer and
   * judge does not need fresh sources at all when good findings are already on file.
   *
   * The row chosen is the BEST stored result, not the most recent: LinkedIn present
   * first, then most candidates, then newest. Most-recent would have selected the
   * degraded rows from that same incident.
   *
   * Falls back to a normal fetching run when nothing usable is stored, so a prospect that
   * has never been researched still works.
   *
   * DEFAULTS TO TRUE. The default was false until 2026-08-20, and because no caller in the
   * repo ever opted in, every run re-fetched every source and paid for a fresh synthesis.
   * That default turned 13 prospects into 176 research runs in one day. Reuse is now the
   * safe path and a caller that genuinely needs fresh sources opts out with false.
   */
  use_stored_findings?: boolean
}

export interface ResearchBatchInput {
  prospect_ids: string[]
  client_id: string
  /** See ResearchInput.use_stored_findings. Applies to every prospect in the batch. Defaults to true. */
  use_stored_findings?: boolean
  skip_existing?: boolean
  confirm_before_run?: boolean  // default true; set false for programmatic/test use under 10 prospects
  concurrency?: number          // max simultaneous prospect calls; default 5 (Apollo/Brave rate limit ceiling)
}

export interface ResearchBatchFailure {
  prospect_id: string
  error: string
}

/** One prospect's trigger reusing a sentence frame already used by an earlier prospect. */
export interface ResearchFrameCollision {
  prospect_id: string
  /** The prospect that used this frame first. */
  first_seen_prospect_id: string
  /** The repeated skeleton, e.g. "is a particular kind of". */
  frame: string
  /** The repeating trigger text, verbatim. */
  trigger_text: string
}

export interface ResearchBatchSummary {
  total: number
  completed: number
  skipped: number
  failed: number
  failures: ResearchBatchFailure[]
  failed_log_path: string | null
  /**
   * Repeated sentence frames across the OBSERVATION half of shipped triggers. Report only:
   * an observation is anchored to a named fact about one person, so it varies naturally and
   * gating it would reject legitimate copy.
   */
  frame_collisions: ResearchFrameCollision[]
  /**
   * Repeated sentence frames across the BRIDGE half. This is GATED during the run, so a
   * non-empty array means the gate failed and is a defect, not a warning. Recomputed after
   * the run from what actually shipped rather than trusted from the gate that enforced it.
   */
  bridge_frame_collisions: ResearchFrameCollision[]
  /** Shipped closing questions used by more than one prospect. Also gated, so also zero. */
  question_collisions: ResearchFrameCollision[]
  /** Distinct closing questions across everything that shipped in this batch. */
  distinct_questions: number
  /**
   * Abstract nouns found in shipped openings, REPORT ONLY. Nothing acts on this. It exists
   * so the concrete-nouns rule can be checked against real output instead of assumed to
   * have worked, and a word list is the wrong instrument for gating copy.
   */
  abstract_noun_hits: ResearchAbstractNounHit[]
  /** Total across the batch. Zero is the target and is not enforced. */
  abstract_noun_total: number
}

/** One prospect's abstract-noun count, for the batch report. */
export interface ResearchAbstractNounHit {
  prospect_id: string
  /** Which listed nouns appeared, e.g. ["remainder", "engine"]. */
  nouns: string[]
  count: number
  /** The opening they appeared in, verbatim, so the report is actionable. */
  opening: string
}
