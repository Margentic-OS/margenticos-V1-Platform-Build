// Synthesis step for prospect research agent v2.
// Loads client ICP/Positioning/TOV documents, builds context, calls Sonnet 4.6.
// Parses <reasoning> chain-of-thought then the JSON output.
// On any parse failure: returns icp_fit cannot_tell with low confidence rather than throwing.
// A failed or unreadable answer reaches no grade, so it records none.
// Model: claude-sonnet-4-6 (per ADR-013).

import Anthropic, { RateLimitError } from '@anthropic-ai/sdk'
import type { MessageCreateParamsNonStreaming, Message } from '@anthropic-ai/sdk/resources/messages'
import { createClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { buildSynthesisPrompt, buildSignalBlock } from './prompts/synthesis-prompt'
import { scrubAITells } from '@/lib/style/customer-facing-style-rules'
import { throwIfFatal } from '@/lib/agents/fatal-api-error'
import { readabilityScore, type ReadabilityScore } from '@/lib/style/readability'
import {
  SIX_TESTS, INFERENCE_DIRECTIONS, ZERO_TOKEN_USAGE, ICP_FIT_OUTCOMES,
  FIT_CHECKS, FIT_CHECK_RESULTS, unknownFitChecks, readTokenUsage, addTokenUsage,
} from './types'
import { formatCompanyFacts, COMPANY_FACTS_PREAMBLE } from './company-facts'
import { rankCandidates, byTriggerPositionOnly, type RankedCandidate } from './rank-candidates'
import { findAssumedCapacityClaims } from '@/lib/style/assumed-capacity'
import { fleschKincaidGrade, MAX_READING_GRADE } from '@/lib/style/reading-grade'
import { stripProperNouns } from '@/lib/style/sentence-frames'
import { checkActivityVerdict } from '@/lib/style/activity-verdict'
import { TRIGGER_REASON_MAX_WORDS, TRIGGER_REASON_MAX_GRADE } from '@/agents/trigger-evidence-gate'
import {
  readStoredFitDimensions, readDimensionAnswers, gradeFromDimensions, type FitDimension,
} from './fit-dimensions'
import type {
  IcpFit, FitChecks, ProspectContext, RawSourceData, SynthesisOutput,
  ObservationCandidate, CandidateScores, CandidateSource, SignalRelevance,
  CandidateReadability, InferenceDirection, TriggerSource, SelectionBasis,
} from './types'

const SYNTHESIS_MODEL = 'claude-sonnet-4-6'

// ─── The output ceiling, and what happens when an answer reaches it ──────────
//
// ONE NAME FOR THE CEILING, because three places now have to agree about it: the request
// that sets it, the retry instruction that tells the model it was hit, and the tests. It
// was a bare literal and the retry instruction would have been a second copy.
export const SYNTHESIS_MAX_OUTPUT_TOKENS = 24000

/**
 * Did this answer reach the output ceiling?
 *
 * The JSON is the LAST thing the answer writes, so an answer that reached the ceiling has
 * always lost it. That makes truncation a total loss rather than a partial one, and it is
 * why this is a named predicate rather than an inline `stop_reason` comparison at three
 * call sites: the inline path, the batch sweep and the collect agent all have to reach the
 * same verdict about the same Message, and a fourth reader will come along.
 */
export function wasTruncated(response: Message): boolean {
  return response.stop_reason === 'max_tokens'
}

/**
 * The one reason string for a truncated answer.
 *
 * Read by the fallback that ships, by the batch entry's `error` column, and by the log
 * line. It names the token count because that is the number that says how much was paid
 * for nothing, and a reason without it cannot be costed later.
 */
export function truncationReason(outputTokens: number): string {
  return `the answer was cut off at the output ceiling after ${outputTokens} tokens, so its JSON never arrived`
}

// ─── THE TRUNCATION RATE IS NOT A CONSTANT HERE, ON PURPOSE ──────────────────
//
// It would be a figure with an n of 7, and this file already carries the scar of a constant
// quoted onward without its sample size (WEB_SEARCH_SEARCHES_PER_PROSPECT, 1.67 from nine
// lookups against a real 2.83 over 73 prospects).
//
// RE-TAKE IT. The query works on old rows as well as new ones, because stop_reason was always
// stored: only the `state` label was wrong, and that is what this change fixed.
//
//   SELECT count(*)                                            AS billed_answers,
//          count(*) FILTER (WHERE stop_reason = 'max_tokens')  AS truncated,
//          round(100.0 * count(*) FILTER (WHERE stop_reason = 'max_tokens') / count(*), 1) AS pct,
//          round(sum(((usage->>'output_tokens')::numeric) * 7.50 / 1e6)
//                FILTER (WHERE stop_reason = 'max_tokens'), 4) AS usd_discarded
//     FROM synthesis_batch_entries
//    WHERE result_type = 'succeeded';
//
// Measured 2026-09-15: 7 billed answers, 2 truncated, 28.6%, $0.36 discarded. n IS 7 AND
// THAT IS TOO SMALL TO DESIGN AGAINST. The other reading on file is 3 of 39 (7.7%) on
// 2026-09-11 at the previous 16,000 ceiling, so the two disagree by nearly four times and
// are not measuring the same ceiling. Nothing here should be trusted as a rate until a run
// of at least 20 has been through.
//
// WHY THE RATE IS PROBABLY CLIENT-SPECIFIC rather than one number: truncation started once
// the judge began quoting each fit dimension, so the answer's length scales with how many
// dimensions a client's ICP declares. A pooled rate across clients with different dimension
// counts would describe no client. Split by organisation before quoting one.

/**
 * The instruction added to a RETRY after a truncated answer.
 *
 * ── IT GOES IN THE USER MESSAGE, NEVER THE SYSTEM PROMPT ──
 *
 * The system prompt is the cached prefix, measured at roughly 8,500 tokens and read by
 * every prospect in a batch. Putting this in it would give the retry a different prefix
 * from every other call, so the retry would miss the cache AND write a second cache entry
 * nothing else reads. In the user message the cached prefix is untouched and the retry
 * still reads it.
 *
 * It does not lower the ceiling or change any rule. It tells the model which half to
 * sacrifice when it cannot fit both, and the answer is always the reasoning: the parser
 * throws the reasoning away and reads only the JSON, so a brief analysis with complete
 * JSON is a correct answer and a thorough analysis with no JSON is worth nothing.
 */
export const CONSTRAINED_REASONING_INSTRUCTION = `

## Your previous answer to this prospect was cut off before its JSON arrived

It reached the ${SYNTHESIS_MAX_OUTPUT_TOKENS.toLocaleString('en-US')}-token output ceiling while still inside the <reasoning> block, so it
produced no JSON and was worth nothing.

Write the same eight reasoning items, in order, but keep each to two sentences at most.
Then write the JSON in full.

The JSON is the only part that is read: the parser strips the reasoning and discards it. If
you cannot fit both, shorten the reasoning. Never shorten or omit the JSON.`

// ─── Supabase ─────────────────────────────────────────────────────────────────

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('research/synthesize: missing Supabase env vars')
  return createClient(url, key)
}

// ─── Client document loading ─────────────────────────────────────────────────

/**
 * The deterministic recency check, as of the moment the request was built.
 *
 * Named and exported because the batch path snapshots it. It is a pure function of the
 * sources AND THE CLOCK, so recomputing it when a batch result comes back 24 hours later
 * can flip has_dateable_signal for a prospect whose LinkedIn post sat near the
 * SIGNAL_THRESHOLDS_DAYS boundary.
 */
export interface DetectedSignal {
  has_dateable_signal: boolean
  signal_observation:  string | null
}

/** One of the client's own triggers: the event, and why that event creates a need. */
export interface ClientTrigger {
  trigger: string
  /** Empty for a document written before the reason field existed. */
  reason: string
}

export interface ClientDocContext {
  clientName:         string
  /**
   * The ICP's tier-1 buyer title, RAW, alongside the prose summary that already renders
   * it. Both come from the same read of the same field, so there is one source and no
   * second parse to drift.
   *
   * Raw and not the summary because the consumers want different things from it.
   * icpSummary is several lines of prose built for a synthesis prompt to reason over.
   * The writer and the judge want the noun phrase alone, to name a reader with.
   *
   * NULL WHEN THE DOCUMENT NAMES NO BUYER, never a placeholder. See resolve-buyer.ts.
   */
  buyerTitle:         string | null
  /**
   * The client's OWN trigger list, read from tier_1.triggers at runtime, IN DOCUMENT ORDER.
   *
   * ═══ WHY THIS EXISTS, AND WHY ORDER IS PART OF IT ════════════════════════
   *
   * Until 2026-09-23 selection judged relevance against four_forces.push alone, and the
   * synthesis prompt says so plainly: "Those two are the only definition of relevant there
   * is." Push forces are, by their nature, statements of difficulty. So a candidate could
   * only be relevant by connecting to something going badly.
   *
   * Measured on one client's 20 prospects: every observable capacity change was rejected
   * with an opposite reading of the form "this signals growth, not scarcity" — a hiring
   * post, two staff promotions, a new programme launch. What survived was employment
   * tenure, which is inert enough that no opposite reading bites. 12 of 20 winners came
   * from tenure or a composite; 2 from a dated event.
   *
   * tier_1.triggers is the per-client home for "what makes a call worth asking for now",
   * and it already existed on every client's ICP. Nothing read it.
   *
   * ORDER IS THE RANKING. The ICP prompt instructs the generator to put the strongest
   * first, so position in this array is the client's own statement of strength and
   * selection uses it directly. An empty array means the client has no triggers, and
   * relevance falls back to push forces exactly as before.
   */
  triggers:           ClientTrigger[]
  icpSummary:         string
  positioningSummary: string
  valuePropContext:   string
  tovRules:           string
  /**
   * The client's fit dimensions, read from the approved profile's filter spec. When present,
   * the judge reads each one and the grade is computed from those readings in code. null or
   * absent means the profile carries none, and the judge grades as it always has.
   *
   * OPTIONAL because the batch path snapshots this object onto synthesis_batch_entries, and
   * every snapshot written before this field existed lacks it. Absent reads as none.
   */
  fitDimensions?:     FitDimension[] | null
}

/**
 * EXPORTED for the inline research path, which needs the buyer title at its produceOpening
 * call site and otherwise has no way to reach it: synthesizeResearch loads this context and
 * discards it, returning only SynthesisOutput.
 *
 * A SECOND READ RATHER THAN WIDENING SynthesisOutput, because the inline path has two
 * branches and only one of them synthesizes. The stored-findings branch makes zero calls
 * and never loads this context at all, so a widened SynthesisOutput would carry the buyer
 * title on one branch and nothing on the other, and the reuse path would silently fall to
 * the tier-3 fallback for prospects whose ICP names a buyer perfectly well.
 */
export async function loadClientContext(clientId: string, segmentId: string | null): Promise<ClientDocContext> {
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
      .select('document_type, content, segment_id, icp_filter_spec')
      .eq('organisation_id', clientId)
      .eq('status', 'active')
      .in('document_type', ['icp', 'positioning', 'tov'])
      .order('created_at', { ascending: false }),
  ])

  const clientName = (orgResult.data?.name as string | null) ?? 'the client'

  const docs = docsResult.data ?? []

  // ICP is segment-scoped: use the doc matching the resolved segment.
  // Falls back to any active ICP if the segment match is missing (defensive only).
  const icpRow = (
    docs.find(d => d.document_type === 'icp' && d.segment_id === resolvedSegmentId)
    ?? docs.find(d => d.document_type === 'icp')
  )
  const icpDoc = icpRow?.content as Record<string, unknown> | undefined

  // THE FIT DIMENSIONS, from the same row as the ICP, so the judge reads the list fixed when
  // THIS profile was approved and never another version's. None stored means the judge grades
  // as it always has. Something stored that does not read is said out loud, not skipped quietly.
  const storedDimensions = readStoredFitDimensions(
    (icpRow?.icp_filter_spec as { fit_dimensions?: unknown } | null | undefined)?.fit_dimensions,
  )
  if (storedDimensions.problem) {
    logger.warn('research/synthesize: stored fit dimensions do not read, grading without them', {
      organisation_id: clientId,
      problem: storedDimensions.problem,
    })
  }

  // Positioning and TOV are org-level (segment_id IS NULL) — no segment filter needed.
  const posDoc  = docs.find(d => d.document_type === 'positioning')?.content as Record<string, unknown> | undefined
  const tovDoc  = docs.find(d => d.document_type === 'tov')?.content as Record<string, unknown> | undefined

  // ICP summary: tier 1 buyer title + company type + top push forces + the client's own
  // disqualifying criteria, which the WEAK grade in the prompt reads instead of hardcoding.
  let icpSummary = 'No ICP document available yet.'
  // HOISTED so the raw title survives the block that renders it into prose. Assigned from
  // the same `buyer` read below and nowhere else: two reads of one field is the drift shape
  // this codebase keeps paying for.
  let buyerTitle: string | null = null
  // Hoisted for the same reason buyerTitle is: assigned from one read, inside the icpDoc
  // block, and returned below. A second read would be a second source to drift.
  let triggerList: ClientTrigger[] = []
  if (icpDoc) {
    const t1 = icpDoc.tier_1 as Record<string, unknown> | undefined
    const buyer  = (t1?.buyer_profile as Record<string, unknown> | undefined)?.title as string | undefined
    const stage  = (t1?.company_profile as Record<string, unknown> | undefined)?.stage as string | undefined
    const push   = ((t1?.four_forces as Record<string, unknown> | undefined)?.push as string[] | undefined) ?? []
    // The client's OWN disqualifying criteria, which the prompt's WEAK grade used to
    // hardcode instead. NOT truncated, unlike push above. Truncation on a scoring input is
    // a silent gate removal: MargenticOS names seven and the seventh is the one that
    // reproduces the "sales-led" example this replaces, so any slice() short of the full
    // list would have quietly changed that client's grading while looking like a tidy-up.
    const disqualifiers = ((t1?.disqualifiers as string[] | undefined) ?? [])
      .filter((d): d is string => typeof d === 'string' && d.trim().length > 0)

    // THE TRIGGER LIST, IN DOCUMENT ORDER, NOT TRUNCATED. Truncating a scoring input is a
    // silent gate removal: the same argument the disqualifier comment above makes, and the
    // reason push is the only list here that still gets a slice(). A trigger the client
    // wrote and selection never saw is indistinguishable from one they never wrote.
    //
    // Each entry may be a bare string or { trigger, evidence_to_find }. Both shapes are
    // read, because documents written before the schema settled carry the first.
    //
    // THE REASON TRAVELS WITH THE TRIGGER from 2026-09-24. A trigger with no reason of its
    // own left the copy falling back on the client's core pain, so every email argued the
    // same thing whatever happened to the prospect. A document written before the reason
    // existed carries none, and that reads back as an empty string: the prompt then says
    // what the event is and nothing about why it matters, which is exactly where it was.
    triggerList = ((t1?.triggers as unknown[] | undefined) ?? [])
      .map(t => typeof t === 'string'
        ? { trigger: t, reason: '' }
        : {
            trigger: ((t as Record<string, unknown> | null)?.trigger as string | undefined) ?? '',
            reason: ((t as Record<string, unknown> | null)?.reason as string | undefined) ?? '',
          })
      .filter(t => t.trigger.trim().length > 0)
    // NO DEFAULT VALUES FOR A MISSING BUYER OR STAGE. This line used to read
    // `${buyer ?? 'a hardcoded archetype'} at ${stage ?? 'a hardcoded stage'}`, so a thin
    // ICP did not produce a thin summary. It produced a CONFIDENT one describing a client
    // the document never named, and that description then travelled into the synthesis
    // prompt indistinguishable from a fact the client had actually supplied.
    //
    // Two rules in CLAUDE.md forbid it, and it broke both. No agent may hardcode a buyer
    // archetype or growth model as a universal default, and when intake data is thin an
    // agent must FLAG THE GAP rather than fill it with an assumption. A default value is
    // the opposite of flagging: it is a gap made invisible.
    //
    // Each line is now emitted only if its value is real, and a document with none of
    // them says so, which is what gives the model something honest to reason about.
    buyerTitle = buyer ?? null

    const icpLines = [
      buyer ? `Their ideal client: ${buyer}.` : '',
      stage ? `Company stage: ${stage}.` : '',
      push.length ? `Top pain points (push forces):\n${push.slice(0, 3).map(p => `  - ${p}`).join('\n')}` : '',
    ].filter(Boolean)

    // The disqualifier line is appended AFTER the emptiness check, never inside icpLines.
    // Its "none named" branch is a non-empty string, so folding it in would make
    // icpLines.length >= 1 for a document with no buyer, no stage and no push forces, and
    // the honest "this ICP is thin" fallback below would stop firing. The gap would be
    // filled by a sentence about disqualifiers, which is a gap made invisible: the exact
    // failure the comment above this block was written about.
    const core = icpLines.length > 0
      ? icpLines.join('\n')
      : 'An ICP document exists but names no buyer title, company stage or push forces.'

    // Stated in both directions on purpose. Silence would read as "no disqualifiers apply",
    // and the model would then reach for its own, which is what this change exists to stop.
    const disqualifierLine = disqualifiers.length
      ? `Disqualifying criteria, written by this client. A prospect matching any of these is a clear mismatch:\n${disqualifiers.map(d => `  - ${d}`).join('\n')}`
      : 'This client has named no disqualifying criteria. Grade on the buyer profile, company stage and push forces above, and do not supply criteria of your own.'

    icpSummary = `${core}\n${disqualifierLine}`
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

  logger.debug('research/synthesize: client context loaded', {
    organisation_id: clientId,
    trigger_count: triggerList.length,
    // Said out loud because an empty list changes how relevance is judged, and a silent
    // fallback to push forces is the condition this change exists to make visible.
    relevance_basis: triggerList.length > 0 ? 'triggers + push forces' : 'push forces only',
  })

  return {
    clientName, buyerTitle, triggers: triggerList,
    icpSummary, positioningSummary, valuePropContext, tovRules,
    fitDimensions: storedDimensions.dimensions,
  }
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
): DetectedSignal {
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

/** A 1-based list position, from a number or a string of digits. Null for anything else. */
function parsePosition(v: unknown): number | null {
  if (typeof v !== 'number' && typeof v !== 'string') return null
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 ? n : null
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
    // POSITION, never the trigger's text. See ObservationCandidate.matched_trigger: the list
    // is per client and per ICP version, so the text would be meaningless once it changes.
    //
    // A STRING OF DIGITS IS ACCEPTED, a fraction and a zero are not. Rejecting "3" would have
    // dropped a genuine trigger match over JSON formatting, and a candidate that quietly
    // stops matching ranks below every one that does, which is a silent downgrade for a
    // quirk. Anything that is not a whole position in a 1-based list reads as "matched
    // none", because a position we cannot place is not a match we can rank on.
    matched_trigger: parsePosition(o.matched_trigger),
    is_reshare: asBool(o.is_reshare),
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

/**
 * A RESHARE DESCRIBED AS SOMETHING THEY WROTE. Code's business, not the model's, and it is
 * an exclusion rather than a demotion: the observation is factually wrong about the reader's
 * own life in its first line, and no ranking can make that usable.
 *
 * A reshare of their OWN FIRM'S announcement is still their news and is NOT excluded here.
 * It has to say they shared it, which is the writer's rule, but what it reports is theirs.
 */
const AUTHORSHIP_VERBS = /\b(posted|wrote|said|announced|argued|published|made the case)\b/i
// NOUN FORMS AS WELL AS VERBS. The first version matched only "reshared" and "shared", so
// an observation that DISCLOSED the reshare in a noun ("announced via a reshare of the
// network's post") was excluded for using "announced" beside it. Caught on a real candidate:
// a firm's own partner-network news, correctly labelled, thrown away.
//
// BARE "share" IS DELIBERATELY ABSENT, because "market share" is a different word.
const SHARING_VERBS = /\b(shar(?:ed|es|ing)|reshar(?:e|ed|es|ing)|re-shar(?:e|ed|es|ing)|repost(?:s|ed|ing)?|amplif(?:y|ies|ied|ying)|passed on|boosted)\b/i

/**
 * THE PROSPECT'S REASON IS HELD TO THE TRIGGER REASON'S RULES, using the same modules.
 *
 * Both end up in the same place, the email's second line, so a reason that would be
 * rejected at the trigger must not be accepted at the prospect. The only difference is
 * what happens next: a trigger reason is regenerated, and this one is dropped, because
 * there is a working fallback here and none there.
 */
/**
 * The prospect reason's grade ceiling: the one emails 2 to 4 already use, not Email 1's.
 * See the comment in findProspectReasonFaults for why the units differ.
 */
export const PROSPECT_REASON_MAX_GRADE = MAX_READING_GRADE

export function findProspectReasonFaults(reason: string): string[] {
  const faults: string[] = []
  const words = reason.trim().split(/\s+/).filter(Boolean).length
  if (words > TRIGGER_REASON_MAX_WORDS) faults.push(`${words} words, over ${TRIGGER_REASON_MAX_WORDS}`)
  // GRADED WITH THE NAMES TAKEN OUT, and ONLY here. A trigger's reason is generic by
  // definition and is scored as written; a prospect's reason has to name their firm and
  // their role, and those words are long and cannot be simplified, so the formula charges
  // the sentence for being specific. Measured on the first three prospects a run reached:
  // 6.9, 9.9 and 10.9 against a ceiling of 6, all dropped, so every email fell back to the
  // trigger's generic reason and line two became identical for everyone matching it.
  //
  // THE CEILING IS UNCHANGED, and so are the word cap and the claims check above: those run
  // on the sentence as written, because a name makes a sentence no longer and asserts
  // nothing about the reader's time.
  //
  // AGAINST 8, NOT 6, AND IT IS NOT A NEW NUMBER. MAX_READING_GRADE is the ceiling emails 2
  // to 4 already carry; 6 is Email 1's, measured for a whole email body rather than for one
  // dense sentence. Flesch-Kincaid on a single 13-word sentence runs structurally higher
  // than on a body full of short function words, so holding one sentence to the body's
  // ceiling was applying a number to a different unit than the one it was measured for.
  //
  // MEASURED: with names already removed, 11 of 20 reasons were dropped at 6.7 to 9.3, three
  // of them between 6.7 and 6.8. Every drop fell back to the trigger's generic reason, so
  // line two became identical for everyone matching the same trigger.
  //
  // A TRIGGER'S REASON STAYS AT 6. It is generic by definition, it carries no names, and it
  // is written once per client where a rewrite costs one call.
  const gradedText = stripProperNouns(reason)
  const grade = fleschKincaidGrade(gradedText)
  if (grade && grade.grade > PROSPECT_REASON_MAX_GRADE) {
    faults.push(`reading grade ${grade.grade.toFixed(1)} with names removed, over ${PROSPECT_REASON_MAX_GRADE}`)
  }
  for (const h of findAssumedCapacityClaims(reason)) faults.push(`${h.kind}: "${h.matched}"`)
  // THE VERDICT CHECK, which this function CLAIMED parity on and did not run. A reason
  // rejected at the trigger for passing judgement on the prospect's activity was accepted
  // here, and this is the sentence that reaches the email either way.
  for (const v of checkActivityVerdict(reason, '', { prospectId: 'prospect-reason' }, 'block')) {
    faults.push(`verdict: ${v}`)
  }
  return faults
}

/**
 * EVERY EXCLUSION, IN ONE PLACE. Code decides what is OUT, and that decision is made here so
 * the main event and the supporting event cannot drift apart: a second hand-written copy of
 * this list is how a candidate too weak to be chosen gets stapled to one that was.
 */
export function isHookEligible(c: ObservationCandidate): boolean {
  return c.passes_all
    && !c.readability?.hard_fail
    && c.inference_direction !== 'ambiguous_unhandled'
    && !isReshareWrittenAsTheirOwn(c)
}

export function isReshareWrittenAsTheirOwn(c: ObservationCandidate): boolean {
  if (!c.is_reshare) return false
  return AUTHORSHIP_VERBS.test(c.observation) && !SHARING_VERBS.test(c.observation)
}

/**
 * RECORDS WHAT EACH SIDE CHOSE, so a model choice can be reviewed against the ordering it
 * overrode. position_only_id is what the client's list order alone would have picked, over
 * the SAME eligible set, which is the only fair comparison.
 */
function buildSelectionBasis(
  winner: RankedCandidate,
  ranked: RankedCandidate[],
  eligible: ObservationCandidate[],
  modelChosenId: string | null,
): SelectionBasis {
  // THE RUNNER-UP IS THE BEST OF THE REST, not simply the second in the ordering. When the
  // model chooses something the ordering ranked third, the thing it beat is whatever the
  // ordering put first, and naming the ordering's second would describe a contest that did
  // not happen.
  const runnerUp = ranked.find(c => c.id !== winner.id) ?? null
  const positionOnly = byTriggerPositionOnly(eligible)[0] ?? null
  return {
    chosen_id: winner.id,
    model_chosen_id: modelChosenId,
    arithmetic_chosen_id: ranked[0]?.id ?? null,
    model_differs_from_arithmetic: modelChosenId != null && ranked[0] != null && modelChosenId !== ranked[0].id,
    runner_up_id: runnerUp?.id ?? null,
    ranked_ids: ranked.map(c => c.id),
    position_only_id: positionOnly?.id ?? null,
    // No candidate matched a trigger at all means list position had no opinion, which is
    // not the same as agreeing with the ordering. Reported as no difference, and the null
    // position_only_id beside it says why.
    differs_from_position_only: positionOnly != null && positionOnly.id !== winner.id,
    chosen_basis: winner.rank_basis,
    runner_up_basis: runnerUp?.rank_basis ?? null,
  }
}

// Selection rule, per FIX A3, extended with the readability and inference-direction
// gates. Returns the winner, the relevance grade it earns, and why anything was demoted.
//
// Tier 1 now requires three things, not one: all six tests, a clean readability
// measurement, and a handled inference direction. A candidate that passes the six but
// fails a gate does not vanish. It falls through to Tier 2, where it still surfaces as
// context but never fills the P2 slot in the email. That is the point of the exercise:
// the ORRIN fact should still be FOUND, it just may not be used as written.
function selectCandidate(
  candidates: ObservationCandidate[],
  modelPreferredId: string | null,
  now: Date = new Date(),
): {
  winner: ObservationCandidate | null
  relevance: SignalRelevance
  demotionReason: string | null
  basis?: SelectionBasis | null
} {
  if (candidates.length === 0) {
    return { winner: null, relevance: 'no_signal', demotionReason: null }
  }

  const allPass = candidates.filter(c => c.passes_all)
  // Among the six-out-of-six candidates, only those clearing both gates are hook-eligible.
  const hookEligible = allPass
    // OPTIONAL CHAINING ON readability AND scores, for STORED candidates. This rule now also
    // runs on candidates read back from prospect_research_results (hasUsableCandidate, on every
    // writer path), and rows written before readability was recorded lack the field: three
    // were in the 30-day reuse window on 2026-09-11. Missing reads as "not measured", which is
    // how those candidates were selected when they were written. Complete candidates, which is
    // every freshly parsed one, are unaffected.
    // ONE PREDICATE, shared with the supporting-event filter. See isHookEligible.
    .filter(isHookEligible)

  if (hookEligible.length > 0) {
    // ═══ CODE DECIDES WHAT IS OUT. THE MODEL CHOOSES AMONG WHAT IS LEFT. ═══
    //
    // Changed 2026-09-24, and it reverses the arrangement above it. Everything that filtered
    // hookEligible is a question code can answer: did it pass the six tests, is the sentence
    // readable, was the inference handled, is it traceable, is it a reshare written as
    // something they wrote. Those are checks, and they are absolute.
    //
    // WHICH OF THE SURVIVORS MAKES THE STRONGEST CASE IS NOT A CHECK. It is a judgement
    // about this prospect, and the arithmetic was standing in for one: recency and
    // specificity are real signals but they cannot see that a nine-day-old award matters
    // less to this reader than a three-month-old hire. The ordering is now passed to the
    // model as INFORMATION and the model chooses, which is what ADR-018 asks for where
    // judgement is genuinely required rather than arithmetic dressed as it.
    //
    // THE ORDERING IS STILL COMPUTED, on every run, and both picks are recorded. A model
    // choice that nobody can compare against anything is a choice nobody can review.
    const ranked = rankCandidates(hookEligible, now, c => c.readability?.penalty ?? 0)
    const modelPick = ranked.find(c => c.id === modelPreferredId) ?? null
    // The model's pick is honoured whenever it named an ELIGIBLE candidate. Naming an
    // ineligible one, or naming nothing, falls back to the ordering rather than failing:
    // the eligible set is never empty here, so there is always a defensible answer.
    const winner = modelPick ?? ranked[0]
    return {
      winner: hookEligible.find(c => c.id === winner.id) ?? null,
      relevance: 'use_as_hook',
      demotionReason: null,
      basis: buildSelectionBasis(winner, ranked, hookEligible, modelPick?.id ?? null),
    }
  }

  // Every six-out-of-six candidate was blocked by a gate. Record why before falling through.
  const demotionReason = allPass.length > 0
    ? `${allPass.length} candidate(s) passed all six tests but were blocked from hook use. ` +
      allPass.map(c => `${c.id}: ${c.rejection_reason ?? 'gate failure'}`).join(' | ')
    : null

  // Tier 2 — passes SPECIFIC + VERIFIABLE + RELEVANT.
  const partial = candidates
    .filter(c => c.scores?.specific && c.scores?.verifiable && c.scores?.relevant)
    .sort((a, b) => b.score_total - a.score_total)
  if (partial.length > 0) {
    // Same ordering among the partials that tie on score_total. Score total leads here
    // because a mention_only winner is chosen for being the strongest thing we have, and
    // the ranking then separates equals the way it does at tier 1.
    const top = partial.filter(c => c.score_total === partial[0].score_total)
    const rankedPartial = rankCandidates(top, now, c => c.readability?.penalty ?? 0)
    const modelPick = rankedPartial.find(c => c.id === modelPreferredId) ?? null
    const best = modelPick ?? rankedPartial[0]
    return {
      winner: partial.find(c => c.id === best.id) ?? null,
      relevance: 'mention_only',
      demotionReason,
      basis: buildSelectionBasis(best, rankedPartial, partial, modelPick?.id ?? null),
    }
  }

  // Nothing cleared the bar. Failing closed is correct.
  return { winner: null, relevance: 'no_signal', demotionReason }
}

/**
 * Whether synthesis's own selection rule finds ANY candidate it would use: a six-out-of-six
 * candidate clearing both gates or, failing that, one passing SPECIFIC + VERIFIABLE +
 * RELEVANT. False is the do-not-write verdict, the rule's own "Nothing cleared the bar.
 * Failing closed is correct."
 *
 * COMPUTED FROM THE CANDIDATES, NEVER READ FROM selected_candidate_id, and that is the
 * point. The stored-findings path sets selected_candidate_id to null on EVERY run, so a check
 * keyed on it would stop every reuse run. The candidates carry their scores, readability and
 * inference direction on every path, fresh or reused, and this runs the same rule over them,
 * so the verdict is the same on both. The model's preferred id only chooses AMONG winners;
 * whether there is one does not depend on it, so null is passed.
 */
export function hasUsableCandidate(candidates: ObservationCandidate[]): boolean {
  return selectCandidate(candidates, null).winner !== null
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

/** How many unestablished facts are kept. A profile names a handful; more is noise. */
const MAX_UNESTABLISHED = 10

/**
 * The judge's three checks, read strictly. A check it did not answer, or answered with a value
 * outside FIT_CHECK_RESULTS, is unknown: never a yes or a no nobody gave. Built from
 * FIT_CHECKS, so a check added there is read here without a second list to keep in step.
 */
function parseFitChecks(raw: unknown): FitChecks {
  const given = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return Object.fromEntries(FIT_CHECKS.map(name => {
    const c = given[name] && typeof given[name] === 'object' ? given[name] as Record<string, unknown> : null
    if (!c) return [name, { result: 'unknown', evidence: 'The judge did not answer this check.' }]
    const result = FIT_CHECK_RESULTS.find(r => r === c.result) ?? 'unknown'
    const evidence = typeof c.evidence === 'string' && c.evidence.trim() ? c.evidence.trim() : null
    return [name, { result, evidence }]
  })) as FitChecks
}

/**
 * The grade as the judge itself gives it. Used ONLY for a client whose approved profile carries
 * no fit dimension list, which is every profile approved before fit-dimensions.ts existed.
 */
function judgeOwnGrade(parsed: Record<string, unknown>): {
  icp_fit: IcpFit; icp_fit_missing: string | null; icp_fit_unestablished: string[]
} {
  // FOUR OUTCOMES, AND AN ANSWER OUTSIDE THEM IS NOT A GRADE. It records cannot_tell, never a
  // grade nobody reached. This used to record 'moderate', which made an answer the code could
  // not read indistinguishable from a genuine partial fit. See ICP_FIT_OUTCOMES.
  const judged = ICP_FIT_OUTCOMES.find(f => f === parsed.icp_fit)
  const icp_fit: IcpFit = judged ?? 'cannot_tell'
  const missingText = typeof parsed.icp_fit_missing === 'string' ? parsed.icp_fit_missing.trim() : ''
  const icp_fit_missing = icp_fit !== 'cannot_tell'
    ? null
    : judged
      ? (missingText || 'The judge answered cannot_tell without naming what was missing.')
      : `No grade: the judge's icp_fit was not one of the four outcomes (${JSON.stringify(parsed.icp_fit ?? null)}).`

  // FACTS NO SOURCE CAN ESTABLISH, recorded so the gap stays visible instead of turning into
  // a grade or into cannot_tell. See the prompt's "can and cannot establish" block.
  const icp_fit_unestablished = Array.isArray(parsed.icp_fit_unestablished)
    ? parsed.icp_fit_unestablished
        .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
        .map(s => s.trim())
        .slice(0, MAX_UNESTABLISHED)
    : []

  return { icp_fit, icp_fit_missing, icp_fit_unestablished }
}

/**
 * EXPORTED FOR TESTS. The whole selection path lives behind this function: parsing the
 * model's candidates, applying the ordering, and deriving the relevance grade. A test that
 * reaches only rankCandidates proves the comparator and nothing about whether synthesis
 * calls it, which is the seam that has broken before (writer-input, 2026-09-11).
 */
export function parseSynthesisResponse(
  raw: string,
  prospect: ProspectContext,
  icpSummary: string,
  detectedSignal: DetectedSignal,
  dimensions: FitDimension[] | null,
  material: string,
  /**
   * The client's own triggers, so a dropped prospect reason can fall back to the APPROVED
   * reason of the trigger the winner matched. Optional: a caller that does not supply them
   * gets the last-resort fallback, which is the behaviour every caller had before this.
   */
  triggers: ReadonlyArray<{ trigger: string; reason: string }> = [],
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

  // THE GRADE. With a dimension list, the judge reads each dimension and the grade is computed
  // from those readings by fixed rules. A grade it volunteers anyway is ignored: its final word
  // is the part that disagreed with itself on identical input. Without a list, the grade is the
  // judge's own, read as strictly as before.
  const fit_dimensions = dimensions ? readDimensionAnswers(parsed.fit_dimensions, dimensions, material) : null
  const { icp_fit, icp_fit_missing, icp_fit_unestablished } = dimensions && fit_dimensions
    ? gradeFromDimensions(dimensions, fit_dimensions)
    : judgeOwnGrade(parsed)

  // THE THREE CHECKS. A missing or unrecognised answer is unknown, never a yes or a no.
  const fit_checks = parseFitChecks(parsed.fit_checks)

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

  const { winner, relevance: selectedRelevance, demotionReason, basis } =
    selectCandidate(candidates, modelPreferredId)

  // The model's sentence about the choice, kept only when there WAS a choice and only when
  // the ordering actually reached a winner. A sentence explaining a selection that did not
  // happen would read as a decision on the reading file where there was none.
  // THE PROSPECT'S REASON, checked here rather than trusted. It travels into the email's
  // second line, so the shape rules that apply to a trigger's reason apply to it: the same
  // word cap, the same grade ceiling, and the same ban on claims about the reader's time or
  // staffing. A reason failing any of them is DROPPED rather than corrected, and dropping it
  // falls back to relevance_reason, which is what the writer read before this existed.
  const rawProspectReason = typeof parsed.prospect_reason === 'string' ? parsed.prospect_reason.trim() : ''
  const prospectReasonFaults = rawProspectReason ? findProspectReasonFaults(rawProspectReason) : ['empty']

  // ═══ THE FALLBACK CHAIN, AND ITS ORDER IS THE WHOLE POINT ═══
  //
  // 1. the model's own sentence for this prospect, when it passes its checks
  // 2. THE MATCHED TRIGGER'S APPROVED REASON. Generic rather than specific to this
  //    prospect, and that is its only weakness. It was written from the client's documents,
  //    passed the same gates, and says why this KIND of event creates a need.
  // 3. relevance_reason, ONLY when nothing matched a trigger, and logged when used.
  //
  // WHY 3 IS LAST AND LOUD. relevance_reason is derived from the ICP's push forces, and a
  // client whose push forces describe a busy founder produces a reason asserting that this
  // reader is short of time and personally does the selling. Measured across four prospects
  // on 2026-09-23, every unmatched one said exactly that. It is the assumption this whole
  // change removes, so reaching for it is a last resort and has to be visible when it
  // happens, not a silent default that quietly reinstates what was just taken out.
  const winnerTriggerIndex = winner?.matched_trigger ?? null
  const approvedTriggerReason = winnerTriggerIndex != null
    ? triggers[winnerTriggerIndex - 1]?.reason?.trim() ?? ''
    : ''

  let prospect_reason = ''
  let reasonSource: 'prospect' | 'trigger' | 'relevance_fallback' | 'none' = 'none'
  if (prospectReasonFaults.length === 0) {
    prospect_reason = rawProspectReason
    reasonSource = 'prospect'
  } else if (approvedTriggerReason) {
    prospect_reason = approvedTriggerReason
    reasonSource = 'trigger'
  } else if (winner) {
    // Nothing matched a trigger, or the matched trigger carries no reason yet. The writer
    // reads relevance_reason in this case, which is where it read before any of this.
    reasonSource = 'relevance_fallback'
  }

  if (rawProspectReason && prospectReasonFaults.length > 0) {
    logger.warn('synthesis: the prospect reason failed its own shape rules and was dropped', {
      prospect_id: prospect.id, reason: rawProspectReason, faults: prospectReasonFaults,
      fell_back_to: reasonSource,
    })
  }
  if (reasonSource === 'relevance_fallback') {
    // WARN, NOT INFO. This is the path that can reintroduce a claim about the reader's time
    // or their staffing, so it is meant to be noticed in a run's output rather than found
    // later by someone reading the copy.
    logger.warn('synthesis: no trigger reason available, falling back to the ICP relevance reason', {
      prospect_id: prospect.id,
      matched_trigger: winnerTriggerIndex,
      why: winnerTriggerIndex == null ? 'no trigger matched' : 'the matched trigger carries no reason',
    })
  }

  // A SUPPORTING EVENT IS KEPT ONLY IF IT IS A REAL, DIFFERENT, ELIGIBLE CANDIDATE. The
  // model naming the winner twice, or naming something the code excluded, is not a cluster.
  const rawSupporting = typeof parsed.supporting_candidate_id === 'string'
    ? parsed.supporting_candidate_id.trim() : ''
  const supportingCandidate = rawSupporting && rawSupporting !== winner?.id
    ? candidates.find(c =>
        c.id === rawSupporting
        // THE SAME ELIGIBILITY THE WINNER FACES, through one predicate rather than a second
        // hand-written copy of it. The first version listed three of the rules and omitted
        // the inference-direction check and the reshare-attribution exclusion, so a
        // candidate too weak to be the main event could still be stapled to it.
        && isHookEligible(c)
        // AND DATED, which the winner does not have to be. A supporting event exists to say
        // "and this too, at about the same time"; undated it cannot do that job.
        && !!c.date) ?? null
    : null
  const supporting_candidate_id = winner ? supportingCandidate?.id ?? null : null

  const selection_reason = basis && basis.runner_up_id
    && typeof parsed.selection_reason === 'string' && parsed.selection_reason.trim()
    ? parsed.selection_reason.trim()
    : ''

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
    // Overwritten by synthesizeResearch, which is the only caller that saw the response.
    usage: ZERO_TOKEN_USAGE,
    icp_fit,
    icp_fit_missing,
    icp_fit_unestablished,
    fit_checks,
    fit_dimensions,
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
    selection_reason,
    prospect_reason,
    prospect_reason_source: reasonSource,
    supporting_candidate_id,
    selection_basis: basis ?? null,
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
  detectedSignal: DetectedSignal,
): SynthesisOutput {
  // A fallback means the run did not produce a usable candidate, so the prospect gets no
  // trigger at all and composition ships the variant's authored opener. The proxy is
  // retained on the audit row only.
  const icp_pain_proxy = buildIcpPainTrigger(prospect, icpSummary)
  return {
    // Overwritten by synthesizeResearch when a call was actually made. A fallback reached
    // WITHOUT a call, or after one that threw, correctly keeps zero.
    usage: ZERO_TOKEN_USAGE,
    // NO GRADE WAS REACHED, SO NONE IS RECORDED. The call failed, returned no text, or
    // returned something that is not JSON. This used to record 'moderate', a grade nobody
    // gave, which sat indistinguishably beside genuine partial fits.
    icp_fit: 'cannot_tell',
    icp_fit_missing: `No grade: ${errorNote}`,
    icp_fit_unestablished: [],
    fit_checks: unknownFitChecks(`No answer: ${errorNote}`),
    fit_dimensions: null,
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
    selection_reason: '',
    prospect_reason: '',
    prospect_reason_source: 'none',
    supporting_candidate_id: null,
    selection_basis: null,
    // Measured on the proxy so the audit row still records its readability.
    trigger_readability: toCandidateReadability(readabilityScore(icp_pain_proxy)),
    demotion_reason: null,
  }
}

// ─── Retry helper ─────────────────────────────────────────────────────────────

const RETRY_DELAYS_MS = [2_000, 4_000, 8_000]

/**
 * Synthesis could not be performed. DISTINCT FROM "synthesis found nothing", and the whole
 * point of the type is that the two can never again be confused by a caller.
 *
 * A caller that catches this must leave the prospect's stored copy exactly as it found it.
 */
export class SynthesisCallFailedError extends Error {
  constructor(public readonly prospectId: string, public readonly cause: unknown) {
    super(`Synthesis call failed for prospect ${prospectId}: ${String(cause)}`)
    this.name = 'SynthesisCallFailedError'
  }
}

async function callWithRetry(
  client: Anthropic,
  params: MessageCreateParamsNonStreaming,
  prospectId: string,
): Promise<Message> {
  let lastErr: unknown

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      // STREAMED, NOT create(). FIX 5, 2026-09-21. SYNTHESIS_MAX_OUTPUT_TOKENS is 24,000,
      // and at that ceiling the SDK REFUSES a non-streaming request outright: "Streaming is
      // required for operations that may take longer than 10 minutes." It is not a warning
      // and there is no slow path to fall back to; the call throws before it is sent.
      //
      // So the inline research path could not synthesise at all, and had not been able to
      // since the ceiling was raised. Nothing noticed because PRODUCTION DOES NOT USE THIS
      // CALL: the live path submits through messages.batches.create in batch-sweep.ts,
      // which is asynchronous and has no ten-minute request to exceed. Only
      // scripts/run-research.ts and the operator's inline route reach this line, and a
      // fresh run from either returned zero candidates for every prospect.
      //
      // Same pattern as messaging-generation-agent.ts and faq-seed-agent.ts, which both
      // stream for the same reason. finalMessage() resolves to the identical Message shape
      // create() returned, so nothing downstream changes.
      const stream = client.messages.stream(params)
      return await stream.finalMessage() as Message
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

/**
 * The recency signal and the client documents, as they were when the request was built.
 *
 * Returned alongside the request because parsing the RESPONSE needs both, and on the
 * batch path the response arrives up to 24 hours later in a different process. Both are
 * snapshotted onto synthesis_batch_entries rather than re-derived there. See
 * buildSynthesisRequest for why each one cannot be recomputed.
 */
export interface SynthesisRequestContext {
  clientCtx:      ClientDocContext
  detectedSignal: DetectedSignal
}

export interface SynthesisRequest extends SynthesisRequestContext {
  params: MessageCreateParamsNonStreaming
}

/**
 * Build the synthesis request WITHOUT sending it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS IS THE SEAM, AND IT IS THE WHOLE BASIS FOR "NO QUALITY TRADE".
 *
 * synthesizeResearch is a sandwich: pure preparation, ONE api call, pure
 * post-processing. Splitting it for the Batch API means the two halves run in
 * different processes up to 24 hours apart. The only way that is safe is if both the
 * inline path and the batch path run THE SAME CODE, not equivalent code.
 *
 * So this function and synthesisFromMessage below are the two halves, and
 * synthesizeResearch is now defined in terms of them. There is exactly one
 * implementation of each. Byte-identity between the paths is therefore structural, not
 * something a test has to keep verifying: the batch path cannot drift from the inline
 * path without changing the inline path too.
 *
 * ── ttl ──
 * Defaults to Anthropic's 5-minute cache. The BATCH call site passes '1h' because a
 * batch can take up to 24 hours and the docs recommend the longer window for shared
 * context. cache_control is per-call-site, so the two coexist with no flag.
 *
 * PROVISIONAL. Anthropic documents in-batch cache hits as best-effort at 30% to 98%,
 * and a 1-hour write costs 2x base input against 1.25x for 5 minutes. At the bottom of
 * that range the longer TTL is a LOSS. cache_read_input_tokens on the first real batch
 * decides whether it stays.
 */
export async function buildSynthesisRequest(
  prospect: ProspectContext,
  rawData: RawSourceData,
  clientId: string,
  opts: { ttl?: '5m' | '1h' } = {},
): Promise<SynthesisRequest> {
  // TAKES THE CLOCK, which is why the result is returned and snapshotted rather than
  // recomputed when the response comes back. A LinkedIn post sitting just inside
  // SIGNAL_THRESHOLDS_DAYS at build time can be outside it 24 hours later, and
  // has_dateable_signal would flip for a reason that has nothing to do with the research.
  const detectedSignal = detectRecencySignal(rawData, new Date())

  // READS THE DATABASE, and strategy documents can be re-versioned during a batch wait.
  // Returned whole rather than as icpSummary alone so that a RESUBMISSION after a batch
  // expiry rebuilds a byte-identical system prompt. A drifting system prompt would also
  // lose the prompt cache, which is half the reason for batching at all.
  const clientCtx = await loadClientContext(clientId, prospect.segment_id)

  return {
    clientCtx,
    detectedSignal,
    params: buildSynthesisParams(prospect, rawData, clientCtx, detectedSignal, opts.ttl ?? '5m'),
  }
}

/**
 * The user message: everything the judge is shown about THIS prospect. Pure.
 *
 * EXPORTED AND SHARED because it is also the material a fit-dimension quotation is checked
 * against, in synthesisFromMessage. One builder for both, so the judge cannot be shown one
 * text and have its quotations checked against another.
 */
export function buildSynthesisUserMessage(
  prospect: ProspectContext,
  rawData: RawSourceData,
  detectedSignal: DetectedSignal,
): string {
  const researchSections = formatResearchSections(rawData)

  // THE COMPANY, AS ALREADY RECORDED. The judge grades company fit and was shown a staff
  // count for 17 of 111 prospects. See company-facts.ts for what is in here and what is
  // deliberately not. Empty when nothing is on file, so that prospect gets the same bytes it
  // got before this section existed.
  const companyFacts = formatCompanyFacts(prospect.company)
  const companySection = companyFacts ? `## Company on file\n\n${COMPANY_FACTS_PREAMBLE}\n\n${companyFacts}\n\n` : ''

  // THE JOB TITLE, FROM THE COLUMN THAT HOLDS IT. This read prospects.role, which only the
  // old research agent ever wrote: empty on all 111 researched prospects for the live client,
  // while job_title was filled on all 111, so every request told the judge "Role: Unknown"
  // (measured 2026-09-11 on 20 real requests). role stays as a fallback for the older rows
  // that carry it and no job_title.
  const roleLine = prospect.job_title ?? prospect.role ?? 'Unknown'

  // THE COUNTRY, FROM THE COLUMN THAT HOLDS IT. Filled for all 111 researched prospects for the
  // live client and never sent until now, so the judge was left to find location in the research
  // and read it as unknown for 6 of 13 prospects in a measured run, which is most of what put
  // them in cannot_tell. Labelled as a record rather than a finding, so it is not mistaken for
  // something this research established.
  const countryLine = prospect.country
    ? `${prospect.country} (recorded when this prospect was sourced)`
    : 'Not recorded'

  const fullName = [prospect.first_name, prospect.last_name].filter(Boolean).join(' ') || 'Unknown'
  const userMessage = `## Prospect\n\nName: ${fullName}\nRole: ${roleLine}\nCompany: ${prospect.company_name ?? 'Unknown'}\nCountry: ${countryLine}\nLinkedIn: ${prospect.linkedin_url ?? 'Not provided'}\n\n${companySection}## Recency check\n\n${buildSignalBlock(detectedSignal.signal_observation)}\n\n## Research gathered\n\n${researchSections}\n\nNow reason through the research and produce the classification JSON.`
  return userMessage
}

/**
 * The request body itself. Pure: same inputs, byte-identical output, no clock and no
 * database. That is what lets a resubmission after a batch expiry reproduce the exact
 * bytes, and therefore hit the same cache entry.
 */
export function buildSynthesisParams(
  prospect: ProspectContext,
  rawData: RawSourceData,
  clientCtx: ClientDocContext,
  detectedSignal: DetectedSignal,
  ttl: '5m' | '1h' = '5m',
  /**
   * Retry after a truncated answer. Appends CONSTRAINED_REASONING_INSTRUCTION to the USER
   * message and changes nothing else, so the cached system prefix is byte-identical to a
   * first attempt and the retry still reads it. Default false keeps every existing caller,
   * and the batch resubmission path, producing the exact same bytes as before.
   */
  constrainReasoning = false,
): MessageCreateParamsNonStreaming {
  // Per-client only. The per-prospect signal moved to the user message so this string is
  // byte-identical across a batch and can therefore be cached. See buildSignalBlock.
  const systemPrompt = buildSynthesisPrompt(clientCtx)
  const userMessage = buildSynthesisUserMessage(prospect, rawData, detectedSignal)
    + (constrainReasoning ? CONSTRAINED_REASONING_INSTRUCTION : '')

  return {
    model: SYNTHESIS_MODEL,
    // 24000, and neither earlier ceiling was theoretical. Three of twelve prospects in the
    // 2026-08-19 batch hit exactly 8000 output tokens; three of 39 calls hit exactly 16000 on
    // 2026-09-11, once the judge began reading each fit dimension with a quotation. The JSON is
    // the LAST thing in the answer, so a truncated answer always loses it and reaches no grade.
    //
    // Raising the ceiling costs nothing on an answer that does not need it, because output
    // tokens are billed as generated. Measured with a ten-dimension list, answers ran 5,800 to
    // 13,000 tokens, so this leaves room for a longer list rather than only for today's.
    max_tokens: SYNTHESIS_MAX_OUTPUT_TOKENS,
    // ZERO, FOR THIS CALL ONLY. What this call produces is a verdict: icp_fit, the
    // qualification, which candidate wins. At the API default of 1.0 the same judge
    // disagreed with itself on 4 of 7 prospects given byte-identical input (2026-09-11),
    // which is larger than the evidence change being measured through it. A verdict gains
    // nothing from sampling variety. The candidate observations it writes still differ
    // between prospects, because each prospect's research does.
    //
    // THE WRITER IS DELIBERATELY NOT PINNED, and nothing here changes that. See the comment
    // above its messages.create in write-opening.ts: the batch uniqueness gate needs variety
    // between prospects' copy, and that reason does not apply to a classification.
    temperature: 0,
    // CACHED. The system prompt is ~6,700 tokens of instruction that does not vary
    // within a client's batch, and every prospect paid full input price for it. The
    // breakpoint sits on the system block, so the per-prospect user message below is
    // outside the cached prefix, which is the whole reason buildSignalBlock moved there.
    //
    // Cache reads are ~10% of input price, so this is a loss on a single-prospect run
    // and a gain from the second prospect onwards. Batches are the normal case.
    //
    // ── CACHE TTL ────────────────────────────────────────────────────────────
    // The LIVE path keeps the 5-minute default. Measured on the console at 4.14
    // reads per write, where the arithmetic favours it:
    //     5-minute at 4.14 reads/write : (1.25 + 0.1*3.14) / 4.14 = 0.378x
    //     1-hour   at B    reads/write : (2.00 + 0.1*(B-1)) / B
    // Equal at B = 6.84, so live would need 6.84 reads per write to justify 1h and
    // gets 4.14. A 1-hour TTL was tried on the live path on 2026-08-25 and reverted
    // on 2026-08-26 before any batch ran on it.
    //
    // The BATCH call site passes '1h', because a batch can exceed the 5-minute window
    // outright and a 13-call probe measured 85% at 1h against 69% at 5m in-batch.
    // Still provisional: see buildSynthesisRequest.
    system: [{
      type: 'text',
      text: systemPrompt,
      cache_control: ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' },
    }],
    messages: [{ role: 'user', content: userMessage }],
  } satisfies MessageCreateParamsNonStreaming
}

/**
 * Turn a finished Anthropic Message into a SynthesisOutput.
 *
 * ── TAKES A Message, NOT A STRING, ON PURPOSE ──
 *
 * The Batch API returns `result.message`, which is the same Message shape the Messages
 * API returns. Passing the whole object means the batch path reconstructs nothing: the
 * no-text-block fallback, the max_tokens truncation check and the usage read are all one
 * implementation serving both paths. A string signature would have forced the batch side
 * to rebuild a partial Message and the two would have drifted at the first edge case.
 *
 * PURE. No clock, no database, no network. Given the same Message, prospect, clientCtx
 * and detectedSignal it returns the same SynthesisOutput, which is exactly the guarantee
 * the split rests on. Candidate selection is arithmetic (selectCandidate), the trigger
 * gate is arithmetic (applyTriggerReadabilityGate), and scrubAITells is deterministic.
 */
export function synthesisFromMessage(
  response: Message,
  prospect: ProspectContext,
  clientCtx: ClientDocContext,
  detectedSignal: DetectedSignal,
  // The sources the judge was shown. Read only when the client has a fit dimension list: the
  // user message is rebuilt from them, and every quotation is checked against that message.
  rawData: RawSourceData,
): SynthesisOutput {
  // THE ONE PLACE THAT HAS THE RESPONSE. Every SynthesisOutput producer below defaults
  // usage to zero; this is what makes it true. Read before any early return, so a
  // no-text-block or parse-failure fallback still reports the tokens the call cost.
  const callUsage = readTokenUsage(response.usage)

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    logger.warn('research/synthesize: no text block in response')
    return { ...buildFallbackSynthesis(prospect, clientCtx.icpSummary, '', 'No text block in response', detectedSignal), usage: callUsage }
  }

  // AN ANSWER WE CUT OFF IS ITS OWN FAILURE, WITH ITS OWN REASON.
  //
  // The JSON is the last thing the judge writes, so an answer that reaches the ceiling has
  // always lost it. This used to log and fall through to the parse, which then recorded
  // "Claude returned non-JSON": a reason that blames the model for something we did, and that
  // reads identically to a genuinely malformed answer. Three of 39 calls landed here on
  // 2026-09-11 and every one of them was recorded that way.
  //
  // It returns rather than parsing, even if what arrived happens to parse: the rest of the
  // answer is missing, so any grade in it was reached without the candidates that follow it.
  if (wasTruncated(response)) {
    const producedTokens = response.usage?.output_tokens ?? 0
    logger.error('research/synthesize: the answer was cut off at the output ceiling, so no grade was reached', {
      prospect_id: prospect.id,
      output_tokens: producedTokens,
    })
    return {
      ...buildFallbackSynthesis(
        prospect, clientCtx.icpSummary, '',
        truncationReason(producedTokens),
        detectedSignal,
      ),
      usage: callUsage,
    }
  }

  // The material is built only when there is a dimension list to check quotations for.
  const dimensions = clientCtx.fitDimensions?.length ? clientCtx.fitDimensions : null
  const material = dimensions ? buildSynthesisUserMessage(prospect, rawData, detectedSignal) : ''
  const result = parseSynthesisResponse(textBlock.text, prospect, clientCtx.icpSummary, detectedSignal, dimensions, material, clientCtx.triggers)

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
    usage: callUsage,
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
}

/**
 * The fallback for a synthesis that never produced a Message at all.
 *
 * Exported because the batch path needs it: an entry that comes back `errored` from
 * Anthropic has no Message to parse, and inventing an empty one would send it down
 * synthesisFromMessage's no-text-block branch with a misleading reason string.
 */
export function synthesisFallback(
  prospect: ProspectContext,
  clientCtx: ClientDocContext,
  detectedSignal: DetectedSignal,
  reason: string,
): SynthesisOutput {
  return buildFallbackSynthesis(prospect, clientCtx.icpSummary, '', reason, detectedSignal)
}

/**
 * Retry a truncated synthesis ONCE, with the reasoning constrained.
 *
 * ── WHY THIS IS A FUNCTION AND NOT A LOOP IN EACH CALLER ──
 *
 * Both paths reach a truncated answer and both must do the same thing about it, but they
 * reach it from different places: the inline path has just made the call, and the collect
 * agent is reading a Message a batch produced up to 24 hours earlier. Two copies of "build
 * the params again with the flag set, call once, decide whether the result is usable" is
 * the two-implementations-that-must-agree shape, and a drift between them would show up as
 * different research for prospects that happened to go down the other path.
 *
 * ── ONE RETRY, NOT A LOOP ──
 *
 * A truncated answer costs a full ceiling of output tokens, about $0.20 at batch rates. A
 * second truncation is evidence the material genuinely does not fit, not bad luck, so a
 * third attempt would spend another $0.20 to learn the same thing. The caller records the
 * failure and the approved template ships.
 *
 * Returns the retry's Message whatever it says, INCLUDING one that truncated again, so the
 * caller can read its usage: that call was billed too. `null` means the retry could not be
 * made at all, which is different from a retry that was made and failed.
 */
export async function retryTruncatedSynthesis(
  client: Anthropic,
  prospect: ProspectContext,
  rawData: RawSourceData,
  clientCtx: ClientDocContext,
  detectedSignal: DetectedSignal,
): Promise<Message | null> {
  const params = buildSynthesisParams(prospect, rawData, clientCtx, detectedSignal, '5m', true)

  try {
    const response = await callWithRetry(client, params, prospect.id)
    logger.warn('research/synthesize: retried a truncated answer with the reasoning constrained', {
      prospect_id: prospect.id,
      retry_output_tokens: response.usage?.output_tokens ?? 0,
      retry_truncated_again: wasTruncated(response),
    })
    return response

  } catch (err) {
    // A fatal account condition must abort rather than degrade, exactly as on the first
    // call: a spent balance is not a per-prospect fact.
    throwIfFatal(err, `synthesis truncation retry for prospect ${prospect.id}`)
    logger.error('research/synthesize: the truncation retry itself failed', {
      prospect_id: prospect.id,
      error: String(err),
    })
    return null
  }
}

export async function synthesizeResearch(
  prospect: ProspectContext,
  rawData: RawSourceData,
  clientId: string,
): Promise<SynthesisOutput> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('research/synthesize: ANTHROPIC_API_KEY not set')

  const { params, clientCtx, detectedSignal } = await buildSynthesisRequest(prospect, rawData, clientId)

  const client = new Anthropic({ apiKey })

  try {
    // The request body, the retry policy and the parse all live elsewhere now, so the
    // batch path runs exactly these lines' logic with the api call swapped out. What
    // remains here is what is genuinely inline-only: holding an HTTP connection open,
    // retrying a 429 in-process, and aborting on a fatal account error.
    const response = await callWithRetry(client, params, prospect.id)
    if (!wasTruncated(response)) {
      return synthesisFromMessage(response, prospect, clientCtx, detectedSignal, rawData)
    }

    // ── TRUNCATED. RETRY ONCE, AND KEEP THE COST OF THE ANSWER WE THREW AWAY ──
    //
    // The first call was billed for a full ceiling of output tokens and produced nothing
    // usable. Returning only the retry's usage would under-report the prospect by that
    // whole amount, which is the line this entire change exists to make visible.
    const discardedUsage = readTokenUsage(response.usage)
    const retry = await retryTruncatedSynthesis(client, prospect, rawData, clientCtx, detectedSignal)

    // No retry was made at all. One call, one usage, the fallback ships.
    if (!retry) return synthesisFromMessage(response, prospect, clientCtx, detectedSignal, rawData)

    // Two calls happened. synthesisFromMessage reports the retry's usage, so add the
    // discarded one: whether the retry succeeded or truncated again, both were billed.
    const out = synthesisFromMessage(retry, prospect, clientCtx, detectedSignal, rawData)
    return { ...out, usage: addTokenUsage(discardedUsage, out.usage) }

  } catch (err) {
    // A spent credit balance or a rejected key is not a per-prospect condition. Falling
    // through to the proxy here is what made a billing failure look like a clean run:
    // seven credit errors, batch reported completed 6 failed 0, two verified 6/6
    // observations quietly replaced with nothing. Abort instead.
    throwIfFatal(err, `synthesis for prospect ${prospect.id}`)
    logger.error('research/synthesize: Claude call failed', { error: String(err), prospect_id: prospect.id })

    // FIX 7, 2026-09-21. AN ERROR IS NOT A VERDICT, AND THIS LINE USED TO MAKE IT ONE.
    //
    // This returned buildFallbackSynthesis, which is a well-formed SynthesisOutput carrying
    // ZERO candidates and no_signal. Downstream cannot tell that apart from a synthesis
    // that ran fine and genuinely found nothing to say: both arrive as "no usable
    // candidate". With allow_overwrite_trigger on, that verdict CLEARS the prospect's
    // existing copy.
    //
    // Measured 2026-09-21: 28 prospects, every synthesis call refused by the SDK before it
    // was sent, and NINETEEN had real personalisation copy deleted and replaced with
    // nothing. Not one model call reached Anthropic. The batch reported "completed".
    //
    // The 9 prospects in that same run whose result INSERT threw kept their copy intact,
    // which is the whole argument in one comparison: the ones that threw were safe, and the
    // ones handed a fallback were not.
    //
    // So: throw. A failed prospect leaves its row untouched, is counted as failed rather
    // than completed, and is picked up again by a resumable re-run. Only a synthesis that
    // actually RAN and found nothing may clear copy, and that path still returns a
    // fallback, further up, where it belongs.
    //
    // The sibling comment above about credit errors reached this same conclusion for FATAL
    // errors and stopped there. The distinction it drew, fatal versus per-prospect, is the
    // wrong axis: a per-prospect error is still an error, and silently converting one into
    // a content decision is what destroyed the copy.
    throw new SynthesisCallFailedError(prospect.id, err)
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
