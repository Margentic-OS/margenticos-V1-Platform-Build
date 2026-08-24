// Synthesis step for prospect research agent v2.
// Loads client ICP/Positioning/TOV documents, builds context, calls Sonnet 4.6.
// Parses <reasoning> chain-of-thought then the JSON output.
// On any parse failure: returns moderate icp_fit with low confidence rather than throwing.
// Model: claude-sonnet-4-6 (per ADR-013).

import Anthropic, { RateLimitError } from '@anthropic-ai/sdk'
import type { MessageCreateParamsNonStreaming, Message } from '@anthropic-ai/sdk/resources/messages'
import { createClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { buildSynthesisPrompt } from './prompts/synthesis-prompt'
import { scrubAITells } from '@/lib/style/customer-facing-style-rules'
import { throwIfFatal } from '@/lib/agents/fatal-api-error'
import { readabilityScore, type ReadabilityScore } from '@/lib/style/readability'
import { SIX_TESTS, INFERENCE_DIRECTIONS } from './types'
import type {
  ProspectContext, RawSourceData, SynthesisOutput,
  ObservationCandidate, CandidateScores, CandidateSource, SignalRelevance,
  CandidateReadability, InferenceDirection, TriggerSource,
} from './types'

const SYNTHESIS_MODEL = 'claude-sonnet-4-6'

// ─── Supabase ─────────────────────────────────────────────────────────────────

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('research/synthesize: missing Supabase env vars')
  return createClient(url, key)
}

// ─── Client document loading ─────────────────────────────────────────────────

interface ClientDocContext {
  clientName:         string
  icpSummary:         string
  positioningSummary: string
  valuePropContext:   string
  tovRules:           string
}

async function loadClientContext(clientId: string, segmentId: string | null): Promise<ClientDocContext> {
  const supabase = getServiceClient()

  // Resolve primary segment if the prospect has no segment_id (defensive fallback).
  let resolvedSegmentId = segmentId
  if (!resolvedSegmentId) {
    const { data: primarySeg } = await supabase
      .from('segments')
      .select('id')
      .eq('organisation_id', clientId)
      .eq('is_default', true)
      .single()
    resolvedSegmentId = primarySeg?.id ?? null
  }

  const [orgResult, docsResult] = await Promise.all([
    supabase
      .from('organisations')
      .select('name')
      .eq('id', clientId)
      .single(),
    supabase
      .from('strategy_documents')
      .select('document_type, content, segment_id')
      .eq('organisation_id', clientId)
      .eq('status', 'active')
      .in('document_type', ['icp', 'positioning', 'tov'])
      .order('created_at', { ascending: false }),
  ])

  const clientName = (orgResult.data?.name as string | null) ?? 'the client'

  const docs = docsResult.data ?? []

  // ICP is segment-scoped: use the doc matching the resolved segment.
  // Falls back to any active ICP if the segment match is missing (defensive only).
  const icpDoc = (
    docs.find(d => d.document_type === 'icp' && d.segment_id === resolvedSegmentId)
    ?? docs.find(d => d.document_type === 'icp')
  )?.content as Record<string, unknown> | undefined

  // Positioning and TOV are org-level (segment_id IS NULL) — no segment filter needed.
  const posDoc  = docs.find(d => d.document_type === 'positioning')?.content as Record<string, unknown> | undefined
  const tovDoc  = docs.find(d => d.document_type === 'tov')?.content as Record<string, unknown> | undefined

  // ICP summary: tier 1 buyer title + company type + top push forces.
  let icpSummary = 'No ICP document available yet.'
  if (icpDoc) {
    const t1 = icpDoc.tier_1 as Record<string, unknown> | undefined
    const buyer  = (t1?.buyer_profile as Record<string, unknown> | undefined)?.title as string | undefined
    const stage  = (t1?.company_profile as Record<string, unknown> | undefined)?.stage as string | undefined
    const push   = ((t1?.four_forces as Record<string, unknown> | undefined)?.push as string[] | undefined) ?? []
    icpSummary = [
      `Their ideal client: ${buyer ?? 'founder-led B2B firm'} at ${stage ?? 'growth stage'}.`,
      push.length ? `Top pain points (push forces):\n${push.slice(0, 3).map(p => `  - ${p}`).join('\n')}` : '',
    ].filter(Boolean).join('\n')
  }

  // Positioning summary: plain-text positioning_summary field.
  let positioningSummary = 'No positioning document available yet.'
  let valuePropContext   = 'No value prop context available.'
  if (posDoc) {
    const summary    = posDoc.positioning_summary as string | undefined
    const keyMsgs    = posDoc.key_messages as Record<string, string> | undefined
    const themes     = posDoc.value_themes as Array<Record<string, unknown>> | undefined

    if (summary) positioningSummary = summary

    const hook      = keyMsgs?.cold_outreach_hook ?? null
    const topThemes = (themes ?? [])
      .slice(0, 2)
      .map(t => t.theme as string | undefined)
      .filter((t): t is string => typeof t === 'string' && t.length > 0)

    const parts: string[] = []
    if (hook)            parts.push(`Core pain solved: "${hook}"`)
    if (topThemes.length) parts.push(`Value delivered:\n${topThemes.map(t => `  - ${t}`).join('\n')}`)
    if (parts.length)    valuePropContext = parts.join('\n')

    logger.debug('research/synthesize: positioning context loaded', {
      has_summary:    !!summary,
      has_hook:       !!hook,
      theme_count:    topThemes.length,
      value_prop_ctx: valuePropContext,
    })
  }

  // TOV rules: writing_rules is object[] with shape {rule, why, example_correct, example_violation}.
  let tovRules = 'No TOV guide available yet.'
  if (tovDoc) {
    const writingRulesRaw = tovDoc.writing_rules as Array<Record<string, unknown> | string> | undefined
    const rules = writingRulesRaw
      ?.map(r => (typeof r === 'object' && r !== null ? String(r.rule ?? '') : String(r)))
      .filter(s => s.length > 0)
    const donts  = (tovDoc.do_dont_list as Record<string, unknown> | undefined)?.dont as string[] | undefined
    const parts: string[] = []
    if (rules?.length)  parts.push(`Writing rules:\n${rules.slice(0, 4).map(r => `  - ${r}`).join('\n')}`)
    if (donts?.length)  parts.push(`Don'ts:\n${donts.slice(0, 3).map(d => `  - ${d}`).join('\n')}`)
    if (parts.length) tovRules = parts.join('\n')
  }

  return { clientName, icpSummary, positioningSummary, valuePropContext, tovRules }
}

// ─── Research section formatter ───────────────────────────────────────────────

function formatResearchSections(rawData: RawSourceData): string {
  const sections: string[] = []

  if (rawData.linkedin.available && rawData.linkedin.formatted) {
    sections.push(`### LinkedIn\n\n${rawData.linkedin.formatted}`)
  } else {
    sections.push(`### LinkedIn\n\nNot available. ${rawData.linkedin.error ?? ''}`.trim())
  }

  if (rawData.apollo.available && rawData.apollo.formatted) {
    sections.push(`### Apollo Enrichment\n\n${rawData.apollo.formatted}`)
  } else {
    sections.push(`### Apollo Enrichment\n\nNot available. ${rawData.apollo.error ?? ''}`.trim())
  }

  if (rawData.website.available && rawData.website.content) {
    sections.push(`### Company Website (${rawData.website.url ?? 'unknown URL'})\n\n${rawData.website.content}`)
  } else {
    sections.push(`### Company Website\n\nNot available. ${rawData.website.error ?? ''}`.trim())
  }

  if (rawData.web_search.available && rawData.web_search.combined) {
    sections.push(`### Web Search\n\n${rawData.web_search.combined}`)
  } else {
    sections.push(`### Web Search\n\nNot available. ${rawData.web_search.error ?? ''}`.trim())
  }

  return sections.join('\n\n')
}

// ─── Deterministic recency check ──────────────────────────────────────────────
// Confirmed Apify LinkedIn post shape (from stored blobs, 2026-04-27):
//   post.postedAt = { date: "ISO-string", timestamp: ms, postedAgoText: "...", postedAgoShort: "..." }
//   post.content  = plain text string (NOT post.text or post.commentary)

const DAY_MS = 24 * 60 * 60 * 1000
const SIGNAL_THRESHOLDS_DAYS = { linkedin: 60, podcast_article: 180 } as const

function parseDateSafe(raw: unknown): Date | null {
  if (!raw || typeof raw !== 'string') return null
  const d = new Date(raw)
  return isNaN(d.getTime()) ? null : d
}

const SIGNAL_KEYWORDS = [
  'podcast', 'episode', 'interviewed', 'published', 'authored', 'wrote',
  'article', 'case study', 'guide', 'featured',
]
const MONTH_NAMES = [
  'january','february','march','april','may','june',
  'july','august','september','october','november','december',
]

function extractDatedSignalFromText(text: string, now: Date): string | null {
  const lower = text.toLowerCase()
  if (!SIGNAL_KEYWORDS.some(k => lower.includes(k))) return null

  const isoRe = /\b(202[5-9]-\d{2}-\d{2})\b/g
  let m: RegExpExecArray | null
  while ((m = isoRe.exec(text)) !== null) {
    const d = new Date(m[1])
    if (isNaN(d.getTime())) continue
    const days = (now.getTime() - d.getTime()) / DAY_MS
    if (days >= 0 && days <= SIGNAL_THRESHOLDS_DAYS.podcast_article) {
      const snippet = text.slice(Math.max(0, m.index - 30), m.index + 90)
        .replace(/\s+/g, ' ').trim().slice(0, 90)
      return `Content ${m[1]}: ${snippet}`
    }
  }

  const monthRe = new RegExp(`\\b(${MONTH_NAMES.join('|')})\\s+(202[5-9])\\b`, 'gi')
  while ((m = monthRe.exec(text)) !== null) {
    const monthIdx = MONTH_NAMES.indexOf(m[1].toLowerCase())
    const year = parseInt(m[2])
    const d = new Date(year, monthIdx, 15)
    const days = (now.getTime() - d.getTime()) / DAY_MS
    if (days >= 0 && days <= SIGNAL_THRESHOLDS_DAYS.podcast_article) {
      const snippet = text.slice(Math.max(0, m.index - 30), m.index + 90)
        .replace(/\s+/g, ' ').trim().slice(0, 90)
      return `Content ${m[1]} ${m[2]}: ${snippet}`
    }
  }

  return null
}

function detectRecencySignal(
  rawData: RawSourceData,
  now: Date,
): { has_dateable_signal: boolean; signal_observation: string | null } {
  const posts = rawData.linkedin.available ? (rawData.linkedin.recent_posts ?? []) : []

  if (posts.length > 0) {
    const first = posts[0]
    const postedAtObj = first.postedAt as { date?: string; timestamp?: number } | undefined
    const postDate = parseDateSafe(postedAtObj?.date)
      ?? (typeof postedAtObj?.timestamp === 'number' ? new Date(postedAtObj.timestamp) : null)
    const daysSince = postDate ? (now.getTime() - postDate.getTime()) / DAY_MS : 0

    if (!postDate || daysSince <= SIGNAL_THRESHOLDS_DAYS.linkedin) {
      const dateStr = postDate ? postDate.toISOString().slice(0, 10) : 'recent'
      const text = String(first.content ?? '').replace(/\s+/g, ' ').slice(0, 80)
      return {
        has_dateable_signal: true,
        signal_observation: `LinkedIn post ${dateStr}: ${text}`.trim(),
      }
    }
  }

  if (rawData.web_search.available && rawData.web_search.combined) {
    const hit = extractDatedSignalFromText(rawData.web_search.combined, now)
    if (hit) return { has_dateable_signal: true, signal_observation: hit }
  }

  if (rawData.website.available && rawData.website.content) {
    const hit = extractDatedSignalFromText(rawData.website.content, now)
    if (hit) return { has_dateable_signal: true, signal_observation: hit }
  }

  return { has_dateable_signal: false, signal_observation: null }
}

// ─── JSON + reasoning parser ──────────────────────────────────────────────────

function parseReasoningBlock(text: string): string {
  const match = text.match(/<reasoning>([\s\S]*?)<\/reasoning>/)
  return match ? match[1].trim() : ''
}

function extractJson(text: string): string {
  // Remove reasoning block, then find the JSON object.
  const withoutReasoning = text.replace(/<reasoning>[\s\S]*?<\/reasoning>/, '').trim()
  // Strip optional markdown fences.
  const stripped = withoutReasoning.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  // Find the first { and last } to isolate the JSON object.
  const start = stripped.indexOf('{')
  const end   = stripped.lastIndexOf('}')
  if (start === -1 || end === -1) return stripped
  return stripped.slice(start, end + 1)
}

// ─── Candidate parsing and deterministic selection (FIX A) ───────────────────
//
// The model scores each candidate against the six tests. The SELECTION RULE is
// applied here in code, not by the model (ADR-018): given honest boolean scores,
// choosing the winner is arithmetic, not judgement. passes_all and score_total are
// always derived here and never read from the model's output.

const CANDIDATE_SOURCES: readonly CandidateSource[] =
  ['linkedin', 'apollo', 'website', 'web_search', 'composite'] as const

function asBool(v: unknown): boolean {
  return v === true
}

// Flattens a ReadabilityScore into the shape stored on the candidate. The full score
// object carries the matched sentences too, which are not worth persisting per candidate.
function toCandidateReadability(score: ReadabilityScore): CandidateReadability {
  return {
    hard_fail:                     score.hardFail,
    penalty:                       score.penalty,
    max_sentence_words:            score.maxSentenceWords,
    hedges:                        score.hedges,
    nominalisation_density:        score.nominalisation.density,
    nominalisation_over_threshold: score.nominalisation.exceedsThreshold,
    reasons:                       score.reasons,
  }
}

// An opposite reading has to be a real sentence. A one-word or empty answer is the model
// going through the motions, and the prompt says as much, so it is treated as unhandled.
const MIN_OPPOSITE_READING_CHARS = 15

function parseInferenceDirection(o: Record<string, unknown>): {
  opposite_reading: string | null
  inference_direction: InferenceDirection
} {
  const rawOpposite = typeof o.opposite_reading === 'string' ? o.opposite_reading.trim() : ''
  const opposite_reading = rawOpposite.length >= MIN_OPPOSITE_READING_CHARS ? rawOpposite : null

  // No usable opposite reading means the direction check did not happen, whatever the
  // model claimed. Fail closed.
  if (!opposite_reading) return { opposite_reading: null, inference_direction: 'ambiguous_unhandled' }

  const claimed = INFERENCE_DIRECTIONS.find(d => d === o.inference_direction)
  return { opposite_reading, inference_direction: claimed ?? 'ambiguous_unhandled' }
}

function parseCandidate(raw: unknown, index: number): ObservationCandidate | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>

  const observation = typeof o.observation === 'string' ? o.observation.trim() : ''
  if (!observation) return null

  const provenance = typeof o.provenance === 'string' ? o.provenance.trim() : ''
  const rawScores  = (typeof o.scores === 'object' && o.scores !== null)
    ? o.scores as Record<string, unknown>
    : {}

  const scores: CandidateScores = {
    specific:        asBool(rawScores.specific),
    // No provenance means a human cannot confirm it in 30 seconds. Enforced here
    // rather than trusted from the model.
    verifiable:      asBool(rawScores.verifiable) && provenance.length > 0,
    inferential:     asBool(rawScores.inferential),
    relevant:        asBool(rawScores.relevant),
    useful:          asBool(rawScores.useful),
    non_judgemental: asBool(rawScores.non_judgemental),
  }

  const score_total = SIX_TESTS.filter(t => scores[t]).length
  const passes_all  = score_total === SIX_TESTS.length

  const source = CANDIDATE_SOURCES.find(s => s === o.source) ?? 'website'

  // Readability is MEASURED here, never read from the model. The model's own claim is
  // kept alongside so a disagreement is visible rather than silent.
  const readability = toCandidateReadability(readabilityScore(observation))
  const { opposite_reading, inference_direction } = parseInferenceDirection(o)

  // A candidate is demoted when it clears the six tests but fails one of the two gates
  // added on top of them. Recorded per candidate so the reason is auditable.
  const blockedByReadability = readability.hard_fail
  const blockedByInference   = inference_direction === 'ambiguous_unhandled'
  const demoted = passes_all && (blockedByReadability || blockedByInference)

  const demotionNotes: string[] = []
  if (blockedByReadability) demotionNotes.push(`Readability: ${readability.reasons.join(' ')}`)
  if (blockedByInference) {
    demotionNotes.push(
      opposite_reading
        ? 'Inference direction: both readings plausible and the observation commits to one.'
        : 'Inference direction: no opposite reading supplied.',
    )
  }

  const modelRejection = typeof o.rejection_reason === 'string' && o.rejection_reason.trim()
    ? o.rejection_reason.trim()
    : null

  return {
    id: typeof o.id === 'string' && o.id.trim() ? o.id.trim() : `c${index + 1}`,
    observation,
    source,
    provenance,
    date: typeof o.date === 'string' && o.date.trim() ? o.date.trim() : null,
    is_composite: asBool(o.is_composite) || source === 'composite',
    scores,
    passes_all,
    score_total,
    model_readable_claim: asBool(rawScores.readable),
    opposite_reading,
    inference_direction,
    readability,
    demoted,
    rejection_reason: demotionNotes.length > 0
      ? demotionNotes.join(' ')
      : modelRejection,
  }
}

// Selection rule, per FIX A3, extended with the readability and inference-direction
// gates. Returns the winner, the relevance grade it earns, and why anything was demoted.
//
// Tier 1 now requires three things, not one: all six tests, a clean readability
// measurement, and a handled inference direction. A candidate that passes the six but
// fails a gate does not vanish. It falls through to Tier 2, where it still surfaces as
// context but never fills the P2 slot in the email. That is the point of the exercise:
// the CRC fact should still be FOUND, it just may not be used as written.
function selectCandidate(
  candidates: ObservationCandidate[],
  modelPreferredId: string | null,
): { winner: ObservationCandidate | null; relevance: SignalRelevance; demotionReason: string | null } {
  if (candidates.length === 0) {
    return { winner: null, relevance: 'no_signal', demotionReason: null }
  }

  const allPass = candidates.filter(c => c.passes_all)
  // Among the six-out-of-six candidates, only those clearing both gates are hook-eligible.
  const hookEligible = allPass
    .filter(c => !c.readability.hard_fail && c.inference_direction !== 'ambiguous_unhandled')
    // Lower readability penalty first: of two legal sentences, the plainer one wins.
    .sort((a, b) => a.readability.penalty - b.readability.penalty)

  if (hookEligible.length > 0) {
    const preferred = hookEligible.find(c => c.id === modelPreferredId)
    // Honour the model's pick only when it is no less readable than the best alternative.
    const winner = preferred && preferred.readability.penalty === hookEligible[0].readability.penalty
      ? preferred
      : hookEligible[0]
    return { winner, relevance: 'use_as_hook', demotionReason: null }
  }

  // Every six-out-of-six candidate was blocked by a gate. Record why before falling through.
  const demotionReason = allPass.length > 0
    ? `${allPass.length} candidate(s) passed all six tests but were blocked from hook use. ` +
      allPass.map(c => `${c.id}: ${c.rejection_reason ?? 'gate failure'}`).join(' | ')
    : null

  // Tier 2 — passes SPECIFIC + VERIFIABLE + RELEVANT.
  const partial = candidates
    .filter(c => c.scores.specific && c.scores.verifiable && c.scores.relevant)
    .sort((a, b) => b.score_total - a.score_total)
  if (partial.length > 0) {
    const preferred = partial.find(c => c.id === modelPreferredId)
    // Prefer the model's pick only when it is at least as strong as the best partial.
    const best = preferred && preferred.score_total === partial[0].score_total ? preferred : partial[0]
    return { winner: best, relevance: 'mention_only', demotionReason }
  }

  // Nothing cleared the bar. Failing closed is correct.
  return { winner: null, relevance: 'no_signal', demotionReason }
}

// trigger_text is the string that actually reaches the prospect: compose-sequence reads
// personalisation_trigger and drops it into the P2 slot whenever signal_relevance is
// use_as_hook. A candidate can clear every gate and the model can still write an
// unreadable trigger out of it, so the trigger is measured on its own terms.
//
// An unreadable trigger loses hook status. The observation still rides along as context
// and composition falls back to ICP pain framing, which is good copy. Failing closed
// beats shipping a 37-word hedged sentence.
//
// Runs twice per synthesis, once on the parsed trigger and again after scrubAITells,
// because scrubbing rewrites the text and the verdict has to describe what actually ships.
function applyTriggerReadabilityGate(
  triggerText: string,
  relevance: SignalRelevance,
  existingDemotionReason: string | null,
): {
  signal_relevance: SignalRelevance
  demotion_reason: string | null
  trigger_readability: CandidateReadability
} {
  const score = readabilityScore(triggerText)

  if (relevance !== 'use_as_hook' || !score.hardFail) {
    return {
      signal_relevance: relevance,
      demotion_reason: existingDemotionReason,
      trigger_readability: toCandidateReadability(score),
    }
  }

  const triggerNote = `trigger_text failed readability: ${score.reasons.join(' ')}`
  return {
    signal_relevance: 'mention_only',
    demotion_reason: existingDemotionReason ? `${existingDemotionReason} | ${triggerNote}` : triggerNote,
    trigger_readability: toCandidateReadability(score),
  }
}

// ─── Trigger must derive from the winning candidate ──────────────────────────
//
// Content-word overlap between the model's trigger_text and the winner's observation.
// Not a similarity score in any principled sense: it answers one question, did the model
// write about the thing the selection rule actually chose.
//
// Threshold calibrated against the fifteen live prospects rather than guessed. Triggers
// correctly derived from their winner scored 0.36 to 0.92. The two that ignored their
// winner scored 0.00 and 0.20. 0.25 sits in the gap.
export const TRIGGER_WINNER_MIN_OVERLAP = 0.25

const OVERLAP_STOPWORDS = new Set([
  'the','a','an','and','or','but','of','to','in','on','for','with','from','at','by','as',
  'is','are','was','were','be','been','has','have','had','that','this','these','those',
  'it','its','they','them','their','he','she','his','her','you','your','we','our','i',
  'most','all','some','any','no','not','still','now','than','then','when','while',
  'because','so','if','which','who','what','where','how','why','since','about','into',
  'over','under','more','less','very','just','only','out','up','down','one','two','three',
  'years','year',
])

function contentWords(text: string): Set<string> {
  return new Set(
    (text ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9\s']/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !OVERLAP_STOPWORDS.has(w)),
  )
}

/** Shared content words as a fraction of the smaller set. 0 when either side is empty. */
export function contentOverlap(a: string, b: string): number {
  const A = contentWords(a)
  const B = contentWords(b)
  if (A.size === 0 || B.size === 0) return 0
  let shared = 0
  for (const w of A) if (B.has(w)) shared++
  return shared / Math.min(A.size, B.size)
}

function parseSynthesisResponse(
  raw: string,
  prospect: ProspectContext,
  icpSummary: string,
  detectedSignal: { has_dateable_signal: boolean; signal_observation: string | null },
): SynthesisOutput {
  const reasoning = parseReasoningBlock(raw)
  const jsonStr   = extractJson(raw)

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(jsonStr) as Record<string, unknown>
  } catch {
    logger.warn('research/synthesize: JSON parse failed, falling back', { raw: raw.slice(0, 200) })
    return buildFallbackSynthesis(prospect, icpSummary, reasoning, 'Claude returned non-JSON', detectedSignal)
  }

  const icp_fit = (['strong', 'moderate', 'weak'] as const)
    .find(f => f === parsed.icp_fit) ?? 'moderate'

  // Candidates + deterministic selection. signal_relevance is DERIVED here, never
  // read from the model output.
  const candidates = Array.isArray(parsed.candidates)
    ? parsed.candidates
        .map((c, i) => parseCandidate(c, i))
        .filter((c): c is ObservationCandidate => c !== null)
    : []

  const modelPreferredId = typeof parsed.selected_candidate_id === 'string'
    ? parsed.selected_candidate_id.trim()
    : null

  const { winner, relevance: selectedRelevance, demotionReason } =
    selectCandidate(candidates, modelPreferredId)

  const qualification_status = (['qualified', 'flagged_for_review', 'disqualified'] as const)
    .find(s => s === parsed.qualification_status) ?? 'qualified'
  const confidence = (['high', 'medium', 'low'] as const)
    .find(c => c === parsed.confidence) ?? 'low'

  const modelTrigger = typeof parsed.trigger_text === 'string' && parsed.trigger_text.trim()
    ? parsed.trigger_text.trim()
    : null

  // The ICP pain proxy. Kept for the audit row, never propagated to the prospect.
  const icp_pain_proxy = modelTrigger ?? buildIcpPainTrigger(prospect, icpSummary)

  // NO WINNER MEANS NO TRIGGER. Writing the proxy into prospects.personalisation_trigger
  // silently defeated the composition gate: resolveTrigger treats any non-null value as
  // source 'research', so three prospects on three different variants received the same
  // generic opening paragraph in place of their variant's authored one. Null here means
  // composition resolves source 'none' and ships the authored opener.
  let trigger_text: string | null = null
  let winnerOverride: string | null = null

  if (winner) {
    // THE WINNER IS THE TRIGGER. The model chooses trigger_text freely and can ignore the
    // candidate the selection rule actually picked: two of fifteen prospects had a 6/6
    // winner on file and a generic ICP sentence written to the prospect. Measured overlap
    // separated the two cases cleanly, mismatches at 0.00 and 0.20 against 0.36 and above
    // for every trigger correctly derived from its winner.
    const overlap = contentOverlap(modelTrigger ?? '', winner.observation)
    if (modelTrigger && overlap >= TRIGGER_WINNER_MIN_OVERLAP) {
      trigger_text = modelTrigger
    } else {
      // Safety net, not the intended path. The observation is written in the third person
      // and reads like a dossier line, so the prompt carries the rule too and this should
      // fire rarely. Firing at all is worth a warning.
      trigger_text = winner.observation
      winnerOverride = `trigger_text did not derive from winner ${winner.id} (overlap ${overlap.toFixed(2)}). Winner observation used instead.`
    }
  }

  const { signal_relevance, demotion_reason: readabilityDemotion, trigger_readability } =
    applyTriggerReadabilityGate(trigger_text ?? '', selectedRelevance, demotionReason)

  const demotion_reason = winnerOverride
    ? (readabilityDemotion ? `${readabilityDemotion} | ${winnerOverride}` : winnerOverride)
    : readabilityDemotion

  return {
    icp_fit,
    has_dateable_signal: detectedSignal.has_dateable_signal,
    // The winning candidate is the observation of record. Fall back to the
    // deterministic recency check only when nothing was selected.
    signal_observation:  winner ? winner.observation : detectedSignal.signal_observation,
    signal_relevance,
    qualification_status,
    qualification_reason: typeof parsed.qualification_reason === 'string'
      ? parsed.qualification_reason
      : null,
    confidence,
    trigger_text,
    icp_pain_proxy,
    trigger_source: buildTriggerSource(winner),
    relevance_reason: typeof parsed.relevance_reason === 'string' ? parsed.relevance_reason : '',
    reasoning,
    candidates,
    selected_candidate_id: winner?.id ?? null,
    trigger_readability,
    demotion_reason,
  }
}

function buildIcpPainTrigger(prospect: ProspectContext, icpSummary: string): string {
  const pushMatch = icpSummary.match(/- (.+)/)
  // Already-plural defaults must not be pluralised again ("practitionerss").
  const rawRole = prospect.role ?? 'practitioners'
  const role = rawRole.endsWith('s') ? rawRole : `${rawRole}s`

  if (!pushMatch) return `Most ${role} at this stage face the same pipeline challenges.`

  // ICP push forces often end with their own full stop; appending another produces "..".
  const rawPain = pushMatch[1].trim().replace(/\.+$/, '')
  // ICP push forces may be gerund phrases ("Struggling to...") or modal-negative phrases
  // ("Can't convert...") or noun phrases ("Inconsistent revenue"). Each needs a different
  // sentence frame to produce grammatical output.
  const isModalNegative = /^(can'?t|cannot|don'?t|doesn'?t)/i.test(rawPain)
  const isGerund = /^(struggling|failing|having|lacking|trying|working|relying|running|finding|spending)/i.test(rawPain)

  // Lowercasing only the first character preserves proper nouns inside the pain text.
  const pain = rawPain.charAt(0).toLowerCase() + rawPain.slice(1)

  if (isModalNegative) return `Most ${role} at this stage find they ${pain}.`
  if (isGerund)        return `Most ${role} at this stage are ${pain}.`
  return `Most ${role} at this stage are dealing with ${pain}.`
}

function buildFallbackSynthesis(
  prospect: ProspectContext,
  icpSummary: string,
  reasoning: string,
  errorNote: string,
  detectedSignal: { has_dateable_signal: boolean; signal_observation: string | null },
): SynthesisOutput {
  // A fallback means the run did not produce a usable candidate, so the prospect gets no
  // trigger at all and composition ships the variant's authored opener. The proxy is
  // retained on the audit row only.
  const icp_pain_proxy = buildIcpPainTrigger(prospect, icpSummary)
  return {
    icp_fit: 'moderate',
    has_dateable_signal: detectedSignal.has_dateable_signal,
    signal_observation:  detectedSignal.signal_observation,
    signal_relevance: 'no_signal',
    qualification_status: 'qualified',
    qualification_reason: null,
    confidence: 'low',
    trigger_text: null,
    icp_pain_proxy,
    trigger_source: null,
    relevance_reason: `Synthesis fallback: no trigger written, ICP pain proxy recorded on the research row only. ${errorNote}`,
    reasoning,
    candidates: [],
    selected_candidate_id: null,
    // Measured on the proxy so the audit row still records its readability.
    trigger_readability: toCandidateReadability(readabilityScore(icp_pain_proxy)),
    demotion_reason: null,
  }
}

// ─── Retry helper ─────────────────────────────────────────────────────────────

const RETRY_DELAYS_MS = [2_000, 4_000, 8_000]

async function callWithRetry(
  client: Anthropic,
  params: MessageCreateParamsNonStreaming,
  prospectId: string,
): Promise<Message> {
  let lastErr: unknown

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await client.messages.create(params) as Message
    } catch (err) {
      if (!(err instanceof RateLimitError)) throw err   // non-rate-limit errors bubble up immediately

      lastErr = err
      if (attempt < RETRY_DELAYS_MS.length) {
        const delayMs = RETRY_DELAYS_MS[attempt]
        logger.warn('research/synthesize: 429 rate limit, retrying', {
          prospect_id: prospectId,
          attempt: attempt + 1,
          retry_after_ms: delayMs,
        })
        await new Promise(resolve => setTimeout(resolve, delayMs))
      }
    }
  }

  // Exhausted all retries — throw so the batch marks this prospect as failed.
  logger.error('research/synthesize: 429 retries exhausted', { prospect_id: prospectId })
  throw lastErr
}

// ─── Public function ──────────────────────────────────────────────────────────

export async function synthesizeResearch(
  prospect: ProspectContext,
  rawData: RawSourceData,
  clientId: string,
): Promise<SynthesisOutput> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('research/synthesize: ANTHROPIC_API_KEY not set')

  const detectedSignal = detectRecencySignal(rawData, new Date())
  const clientCtx = await loadClientContext(clientId, prospect.segment_id)
  const systemPrompt = buildSynthesisPrompt({ ...clientCtx, signalObservation: detectedSignal.signal_observation })
  const researchSections = formatResearchSections(rawData)

  const fullName = [prospect.first_name, prospect.last_name].filter(Boolean).join(' ') || 'Unknown'
  const userMessage = `## Prospect\n\nName: ${fullName}\nRole: ${prospect.role ?? 'Unknown'}\nCompany: ${prospect.company_name ?? 'Unknown'}\nLinkedIn: ${prospect.linkedin_url ?? 'Not provided'}\n\n## Research gathered\n\n${researchSections}\n\nNow reason through the research and produce the classification JSON.`

  const client = new Anthropic({ apiKey })

  try {
    const response = await callWithRetry(
      client,
      // 16000, not 8000. Truncation is not a theoretical risk: three of twelve prospects
      // in the 2026-08-19 batch hit exactly 8000 output tokens, lost their JSON, fell
      // through to the ICP proxy and were recorded as "no_signal" when the run had in
      // fact failed. Each candidate now carries an opposite_reading and a seventh test,
      // so the array outgrew the old ceiling.
      { model: SYNTHESIS_MODEL, max_tokens: 16000, system: systemPrompt, messages: [{ role: 'user', content: userMessage }] } satisfies MessageCreateParamsNonStreaming,
      prospect.id,
    )

    const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      logger.warn('research/synthesize: no text block in response')
      return buildFallbackSynthesis(prospect, clientCtx.icpSummary, '', 'No text block in response', detectedSignal)
    }

    // A truncated response is the most likely cause of a JSON parse failure, and it
    // looks identical to a model error unless stop_reason is checked.
    if (response.stop_reason === 'max_tokens') {
      logger.error('research/synthesize: response truncated at max_tokens — candidates will be lost', {
        prospect_id: prospect.id,
        output_tokens: response.usage?.output_tokens,
      })
    }

    const result = parseSynthesisResponse(textBlock.text, prospect, clientCtx.icpSummary, detectedSignal)

    // Scrubbing rewrites the trigger (em dashes become full stops, AI tells are replaced),
    // so the readability verdict is recomputed on the text that actually ships.
    const scrubbedTrigger = result.trigger_text === null
      ? null
      : scrubAITells(result.trigger_text, `research/prospect/${prospect.id}`)
    const rescored = applyTriggerReadabilityGate(
      scrubbedTrigger ?? '',
      result.signal_relevance,
      result.demotion_reason,
    )

    const scrubbedResult = {
      ...result,
      trigger_text:        scrubbedTrigger,
      signal_relevance:    rescored.signal_relevance,
      demotion_reason:     rescored.demotion_reason,
      trigger_readability: rescored.trigger_readability,
    }

    if (scrubbedResult.demotion_reason) {
      logger.warn('research/synthesize: signal demoted below hook use', {
        prospect_id:      prospect.id,
        signal_relevance: scrubbedResult.signal_relevance,
        reason:           scrubbedResult.demotion_reason,
      })
    }

    logger.debug('research/synthesize: complete', {
      icp_fit:             scrubbedResult.icp_fit,
      has_dateable_signal: scrubbedResult.has_dateable_signal,
      signal_relevance:    scrubbedResult.signal_relevance,
      qualification:       scrubbedResult.qualification_status,
      confidence:          scrubbedResult.confidence,
      candidate_count:     scrubbedResult.candidates.length,
      selected_candidate:  scrubbedResult.selected_candidate_id,
      trigger_max_sentence_words: scrubbedResult.trigger_readability.max_sentence_words,
      trigger_hedges:             scrubbedResult.trigger_readability.hedges,
      trigger_nominalisation:     scrubbedResult.trigger_readability.nominalisation_density.toFixed(3),
    })

    // Fewer than three candidates means the sweep did not run properly. Visible,
    // not silent, so a prompt regression shows up in logs rather than in the copy.
    if (scrubbedResult.candidates.length < 3) {
      logger.warn('research/synthesize: thin candidate set', {
        prospect_id: prospect.id,
        candidate_count: scrubbedResult.candidates.length,
      })
    }
    return scrubbedResult

  } catch (err) {
    // A spent credit balance or a rejected key is not a per-prospect condition. Falling
    // through to the proxy here is what made a billing failure look like a clean run:
    // seven credit errors, batch reported completed 6 failed 0, two verified 6/6
    // observations quietly replaced with nothing. Abort instead.
    throwIfFatal(err, `synthesis for prospect ${prospect.id}`)
    logger.error('research/synthesize: Claude call failed', { error: String(err) })
    return buildFallbackSynthesis(prospect, clientCtx.icpSummary, '', `Claude error: ${String(err)}`, detectedSignal)
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// WHICH SOURCE PRODUCED THE OPENER
//
// trigger_source was hardcoded null from 2026-08-19, so the 224 rows written in that
// window record nothing about which source won. sources_attempted and sources_successful
// only say what RAN, and every run attempts all four, so they are near-constant and
// cannot distinguish a source that reliably produces the winning observation from one
// that returns data nobody ever uses.
//
// That distinction is the only evidence base for deciding whether a paid source earns its
// cost, and at 300 prospects a week the sample builds fast.
//
// WRITTEN WHENEVER A CANDIDATE WINS, not only when the judge ships it. A candidate that
// cleared the six tests and was then held for readability still shows which source
// produced usable material, and holds are common enough that excluding them would bias
// the sample toward whichever source happens to write short sentences. signal_relevance
// on the same row already separates shipped from held, so both questions stay answerable
// from one column.
//
// NOT called on the fallback path: buildFallbackSynthesis has no candidates at all, so
// its trigger_source stays null and correctly means "no winner existed".
function buildTriggerSource(winner: ObservationCandidate | null | undefined): TriggerSource | null {
  if (!winner) return null

  // Candidates carry provenance as free text, not a URL field. Lift a URL out when there
  // is one so the row stays clickable, and keep the whole provenance regardless: "Apollo
  // employment_history entry 2" is not a URL and is still exactly what a human needs to
  // verify the claim in thirty seconds.
  const urlMatch = winner.provenance.match(/https?:\/\/[^\s)"']+/)

  return {
    type: winner.source,
    url: urlMatch ? urlMatch[0] : null,
    date: winner.date,
    description: winner.provenance,
  }
}
