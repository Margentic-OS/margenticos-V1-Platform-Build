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
import type { ProspectContext, RawSourceData, SynthesisOutput, IcpFit, SignalRelevance } from './types'

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

async function loadClientContext(clientId: string): Promise<ClientDocContext> {
  const supabase = getServiceClient()

  const [orgResult, docsResult] = await Promise.all([
    supabase
      .from('organisations')
      .select('name')
      .eq('id', clientId)
      .single(),
    supabase
      .from('strategy_documents')
      .select('document_type, content')
      .eq('organisation_id', clientId)
      .eq('status', 'active')
      .in('document_type', ['icp', 'positioning', 'tov'])
      .order('created_at', { ascending: false }),
  ])

  const clientName = (orgResult.data?.name as string | null) ?? 'the client'

  const docs = docsResult.data ?? []
  const icpDoc  = docs.find(d => d.document_type === 'icp')?.content as Record<string, unknown> | undefined
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
  const signal_relevance = (['use_as_hook', 'ignore'] as const)
    .find(r => r === parsed.signal_relevance) ?? 'ignore'
  const qualification_status = (['qualified', 'flagged_for_review', 'disqualified'] as const)
    .find(s => s === parsed.qualification_status) ?? 'qualified'
  const confidence = (['high', 'medium', 'low'] as const)
    .find(c => c === parsed.confidence) ?? 'low'

  const trigger_text = typeof parsed.trigger_text === 'string' && parsed.trigger_text.trim()
    ? parsed.trigger_text.trim()
    : buildIcpPainTrigger(prospect, icpSummary)

  return {
    icp_fit,
    has_dateable_signal: detectedSignal.has_dateable_signal,
    signal_observation:  detectedSignal.signal_observation,
    signal_relevance,
    qualification_status,
    qualification_reason: typeof parsed.qualification_reason === 'string'
      ? parsed.qualification_reason
      : null,
    confidence,
    trigger_text,
    trigger_source: null,
    relevance_reason: typeof parsed.relevance_reason === 'string' ? parsed.relevance_reason : '',
    reasoning,
  }
}

function buildIcpPainTrigger(prospect: ProspectContext, icpSummary: string): string {
  const pushMatch = icpSummary.match(/- (.+)/)
  const role = prospect.role ?? 'practitioners'

  if (!pushMatch) return `Most ${role}s at this stage face the same pipeline challenges.`

  const rawPain = pushMatch[1].trim()
  // ICP push forces may be gerund phrases ("Struggling to...") or modal-negative phrases
  // ("Can't convert...") or noun phrases ("Inconsistent revenue"). Each needs a different
  // sentence frame to produce grammatical output.
  const isModalNegative = /^(can'?t|cannot|don'?t|doesn'?t)/i.test(rawPain)
  const isGerund = /^(struggling|failing|having|lacking|trying|working|relying|running|finding|spending)/i.test(rawPain)

  if (isModalNegative) return `Most ${role}s at this stage find they ${rawPain.toLowerCase()}.`
  if (isGerund)        return `Most ${role}s at this stage are ${rawPain.toLowerCase()}.`
  return `Most ${role}s at this stage are dealing with ${rawPain.toLowerCase()}.`
}

function buildFallbackSynthesis(
  prospect: ProspectContext,
  icpSummary: string,
  reasoning: string,
  errorNote: string,
  detectedSignal: { has_dateable_signal: boolean; signal_observation: string | null },
): SynthesisOutput {
  return {
    icp_fit: 'moderate',
    has_dateable_signal: detectedSignal.has_dateable_signal,
    signal_observation:  detectedSignal.signal_observation,
    signal_relevance: 'ignore',
    qualification_status: 'qualified',
    qualification_reason: null,
    confidence: 'low',
    trigger_text: buildIcpPainTrigger(prospect, icpSummary),
    trigger_source: null,
    relevance_reason: `Synthesis fallback: ICP pain proxy used. ${errorNote}`,
    reasoning,
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
  const clientCtx = await loadClientContext(clientId)
  const systemPrompt = buildSynthesisPrompt({ ...clientCtx, signalObservation: detectedSignal.signal_observation })
  const researchSections = formatResearchSections(rawData)

  const fullName = [prospect.first_name, prospect.last_name].filter(Boolean).join(' ') || 'Unknown'
  const userMessage = `## Prospect\n\nName: ${fullName}\nRole: ${prospect.role ?? 'Unknown'}\nCompany: ${prospect.company_name ?? 'Unknown'}\nLinkedIn: ${prospect.linkedin_url ?? 'Not provided'}\n\n## Research gathered\n\n${researchSections}\n\nNow reason through the research and produce the classification JSON.`

  const client = new Anthropic({ apiKey })

  try {
    const response = await callWithRetry(
      client,
      { model: SYNTHESIS_MODEL, max_tokens: 3000, system: systemPrompt, messages: [{ role: 'user', content: userMessage }] } satisfies MessageCreateParamsNonStreaming,
      prospect.id,
    )

    const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      logger.warn('research/synthesize: no text block in response')
      return buildFallbackSynthesis(prospect, clientCtx.icpSummary, '', 'No text block in response', detectedSignal)
    }

    const result = parseSynthesisResponse(textBlock.text, prospect, clientCtx.icpSummary, detectedSignal)
    const scrubbedResult = {
      ...result,
      trigger_text: scrubAITells(result.trigger_text, `research/prospect/${prospect.id}`),
    }
    logger.debug('research/synthesize: complete', {
      icp_fit:             scrubbedResult.icp_fit,
      has_dateable_signal: scrubbedResult.has_dateable_signal,
      signal_relevance:    scrubbedResult.signal_relevance,
      qualification:       scrubbedResult.qualification_status,
      confidence:          scrubbedResult.confidence,
    })
    return scrubbedResult

  } catch (err) {
    logger.error('research/synthesize: Claude call failed', { error: String(err) })
    return buildFallbackSynthesis(prospect, clientCtx.icpSummary, '', `Claude error: ${String(err)}`, detectedSignal)
  }
}
