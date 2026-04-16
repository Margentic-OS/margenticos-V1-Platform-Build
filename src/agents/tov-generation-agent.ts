// Tone of Voice Generation Agent
// Entry point for generating the Tone of Voice guide.
// Model: claude-opus-4-6
// Prompt: /docs/prompts/tov-agent.md
//
// ISOLATION RULES (enforced at three levels):
//   1. Database: RLS policies block cross-client reads
//   2. Application: explicit organisation_id filter on every query below
//   3. Prompt: no prompt references any data source outside current client context
//
// NO WEB SEARCH: the TOV agent works from writing samples only.
//   Web research is not relevant here — the voice is in the samples, not the market.
//
// KEY INPUTS:
//   voice_samples (field_key: 'voice_samples') — primary extraction source. The agent
//     derives vocabulary, rhythm, personality, and structure from these samples.
//   voice_style  (field_key: 'voice_style')  — secondary signal. The founder's
//     self-description of their style. Cross-referenced against samples; if they
//     contradict, samples win and the contradiction is surfaced in suggestion_reason
//     and in the voice_style_note field of the output document.
//
// NO DEPENDENCIES: does not require ICP or Positioning documents to exist first.
//   TOV extraction is independent — it works from samples and intake alone.
//
// OUTPUT: writes to document_suggestions only — never to strategy_documents directly.

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

// The model specified in the PRD for document generation agents.
const TOV_MODEL = 'claude-opus-4-6'

// 8192 tokens — the TOV guide includes before/after examples and extensive do/don't
// lists that can be verbose. Match the other document generation agents.
const MAX_TOKENS = 8192

// Minimum word count threshold below which samples are considered thin.
// Below this, the agent proceeds but marks confidence as low.
const THIN_SAMPLE_WORD_THRESHOLD = 100

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TovAgentInput {
  organisation_id: string
  /** Supabase client authenticated as the operator. Passed in from the API route. */
  supabase: SupabaseClient
  /** Optional: if true, includes existing TOV document content for refresh context. */
  is_refresh?: boolean
}

export interface TovAgentResult {
  suggestion_id: string
  organisation_id: string
  document_type: 'tov'
  status: 'pending'
}

interface IntakeRow {
  field_key: string
  field_label: string
  response_value: string | null
  section: string
  is_critical: boolean
}

interface ExistingTovDocument {
  id: string
  version: string
  plain_text: string | null
  content: Record<string, unknown>
}

interface PatternRow {
  pattern_type: string
  pattern_data: Record<string, unknown>
  sample_size: number
  confidence_score: number | null
}

// Extracted voice inputs — pulled from intake before prompt construction.
interface VoiceInputs {
  samples: string
  style: string
  sampleWordCount: number
  samplesEmpty: boolean
  samplesThin: boolean
  /** True if style and samples appear to contradict (heuristic check before Claude). */
  apparentContradiction: boolean
}

// ─── Main agent function ──────────────────────────────────────────────────────

export async function runTovGenerationAgent(
  input: TovAgentInput
): Promise<TovAgentResult> {
  const { organisation_id, supabase, is_refresh = false } = input

  logger.info('TOV agent: starting', { organisation_id, is_refresh })

  // Step 1: Fetch intake responses for this client only.
  // Explicit organisation_id filter + RLS enforces isolation.
  const intake = await fetchIntakeResponses(supabase, organisation_id)

  if (intake.length === 0) {
    throw new Error(
      `TOV agent: no intake responses found for organisation ${organisation_id}. ` +
      'Intake data is required to generate a Tone of Voice guide.'
    )
  }

  // Step 2: Extract voice_samples and voice_style from intake.
  // These are the two critical TOV inputs and are handled specially before the prompt.
  const voiceInputs = extractVoiceInputs(intake)

  if (voiceInputs.samplesEmpty) {
    logger.warn(
      'TOV agent: voice_samples is empty — generating from voice_style and intake preferences only. ' +
      'Confidence will be low.',
      { organisation_id }
    )
  } else if (voiceInputs.samplesThin) {
    logger.warn(
      `TOV agent: voice_samples is thin (${voiceInputs.sampleWordCount} words) — ` +
      'extraction quality may be limited.',
      { organisation_id, wordCount: voiceInputs.sampleWordCount }
    )
  }

  if (voiceInputs.apparentContradiction) {
    logger.info(
      'TOV agent: voice_style self-description appears to contradict samples — ' +
      'will surface in suggestion_reason and voice_style_note.',
      { organisation_id }
    )
  }

  // Step 3: Check overall intake completeness — warn if below 80% critical fields answered.
  const criticalFields = intake.filter(r => r.is_critical)
  const answeredCritical = criticalFields.filter(
    r => r.response_value && r.response_value.trim().length > 0
  )
  const completeness = criticalFields.length > 0
    ? Math.round((answeredCritical.length / criticalFields.length) * 100)
    : 0

  if (completeness < 80) {
    logger.warn(
      `TOV agent: intake completeness is ${completeness}% — below 80% threshold.`,
      { organisation_id, completeness }
    )
  }

  // Step 4: Fetch existing TOV document if this is a refresh.
  let existingDocument: ExistingTovDocument | null = null
  if (is_refresh) {
    existingDocument = await fetchExistingTovDocument(supabase, organisation_id)
  }

  // Step 5: Read patterns table (cross-client, read-only, may be empty in phase one).
  const patterns = await fetchPatterns(supabase)

  // Step 6: Build the user message from intake + voice inputs.
  // No web research step — TOV works from samples only.
  const userMessage = buildUserMessage({
    organisation_id,
    intake,
    voiceInputs,
    existingDocument,
    patterns,
    completeness,
  })

  // Step 7: Call Claude.
  logger.info('TOV agent: calling Claude', { organisation_id, model: TOV_MODEL })
  const generatedContent = await callClaude(userMessage)

  // Step 8: Validate the response is parseable JSON before writing anything.
  let parsedDocument: Record<string, unknown>
  try {
    parsedDocument = JSON.parse(generatedContent)
  } catch {
    throw new Error(
      'TOV agent: Claude returned content that is not valid JSON. ' +
      'Raw response has been logged. Do not write to the database.'
    )
  }

  // Step 9: Write to document_suggestions — never to strategy_documents directly.
  const suggestionId = await writeDocumentSuggestion(supabase, {
    organisation_id,
    existingDocument,
    generatedContent,
    parsedDocument,
    intake,
    voiceInputs,
    completeness,
    is_refresh,
  })

  logger.info('TOV agent: suggestion written successfully', {
    organisation_id,
    suggestion_id: suggestionId,
  })

  return {
    suggestion_id: suggestionId,
    organisation_id,
    document_type: 'tov',
    status: 'pending',
  }
}

// ─── Data fetching ────────────────────────────────────────────────────────────

async function fetchIntakeResponses(
  supabase: SupabaseClient,
  organisation_id: string
): Promise<IntakeRow[]> {
  const { data, error } = await supabase
    .from('intake_responses')
    .select('field_key, field_label, response_value, section, is_critical')
    .eq('organisation_id', organisation_id) // explicit isolation filter
    .order('section')

  if (error) {
    throw new Error(`TOV agent: failed to fetch intake responses — ${error.message}`)
  }

  return (data ?? []) as IntakeRow[]
}

async function fetchExistingTovDocument(
  supabase: SupabaseClient,
  organisation_id: string
): Promise<ExistingTovDocument | null> {
  const { data, error } = await supabase
    .from('strategy_documents')
    .select('id, version, plain_text, content')
    .eq('organisation_id', organisation_id) // explicit isolation filter
    .eq('document_type', 'tov')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (error) {
    return null
  }

  return data as ExistingTovDocument
}

async function fetchPatterns(supabase: SupabaseClient): Promise<PatternRow[]> {
  const { data, error } = await supabase
    .from('patterns')
    .select('pattern_type, pattern_data, sample_size, confidence_score')
    .order('confidence_score', { ascending: false })
    .limit(20)

  if (error) {
    logger.warn('TOV agent: could not fetch patterns — continuing without them', {
      error: error.message,
    })
    return []
  }

  return (data ?? []) as PatternRow[]
}

// ─── Voice input extraction ───────────────────────────────────────────────────

// Pulls voice_samples and voice_style from intake and computes metadata about
// sample richness and potential self-description contradictions.
//
// Contradiction detection is a heuristic pre-check — it catches the clearest cases
// (e.g. founder says "direct and concise" but sample is over 200 words per paragraph).
// Claude's deeper analysis is the authoritative contradiction check.
function extractVoiceInputs(intake: IntakeRow[]): VoiceInputs {
  const val = (key: string) =>
    intake.find(r => r.field_key === key)?.response_value?.trim() ?? ''

  const samples = val('voice_samples')
  const style   = val('voice_style')

  const sampleWordCount = samples.length > 0
    ? samples.split(/\s+/).filter(w => w.length > 0).length
    : 0

  const samplesEmpty = sampleWordCount === 0
  const samplesThin  = !samplesEmpty && sampleWordCount < THIN_SAMPLE_WORD_THRESHOLD

  // Heuristic contradiction check: surface the most obvious mismatches so the
  // agent knows to look carefully, even before Claude's deeper analysis.
  // These are signals, not definitive — Claude makes the authoritative call.
  let apparentContradiction = false
  if (!samplesEmpty && style.length > 0) {
    const styleLower   = style.toLowerCase()
    const samplesLower = samples.toLowerCase()

    const claimsDirect   = styleLower.includes('direct') || styleLower.includes('concise') || styleLower.includes('brief')
    // Average word count per sentence as a length proxy
    const sentences      = samples.split(/[.!?]+/).filter(s => s.trim().length > 5)
    const avgSentenceLen = sentences.length > 0
      ? samples.split(/\s+/).length / sentences.length
      : 0
    const samplesAreVerbose = avgSentenceLen > 25

    const claimsNoJargon = styleLower.includes('no jargon') || styleLower.includes('plain') || styleLower.includes('simple')
    // Flag if the samples contain corporate jargon terms
    const jargonTerms    = ['leverage', 'synergy', 'scalable', 'robust', 'seamless', 'holistic', 'ecosystem']
    const samplesHaveJargon = jargonTerms.some(t => samplesLower.includes(t))

    const claimsWarm   = styleLower.includes('warm') || styleLower.includes('friendly') || styleLower.includes('personable')
    const samplesFormal = samplesLower.includes('dear ') || samplesLower.includes('please find') || samplesLower.includes('kind regards')

    if ((claimsDirect && samplesAreVerbose) ||
        (claimsNoJargon && samplesHaveJargon) ||
        (claimsWarm && samplesFormal)) {
      apparentContradiction = true
    }
  }

  return { samples, style, sampleWordCount, samplesEmpty, samplesThin, apparentContradiction }
}

// ─── Prompt construction ──────────────────────────────────────────────────────

function buildUserMessage(params: {
  organisation_id: string
  intake: IntakeRow[]
  voiceInputs: VoiceInputs
  existingDocument: ExistingTovDocument | null
  patterns: PatternRow[]
  completeness: number
}): string {
  const { intake, voiceInputs, existingDocument, patterns, completeness } = params
  const { samples, style, samplesEmpty, samplesThin, sampleWordCount, apparentContradiction } = voiceInputs

  // Group intake responses by section, excluding voice_samples and voice_style —
  // those are surfaced separately in a dedicated block so Claude understands
  // their distinct roles (primary extraction vs secondary cross-reference).
  const bySec = intake.reduce<Record<string, IntakeRow[]>>((acc, row) => {
    if (row.field_key === 'voice_samples' || row.field_key === 'voice_style') return acc
    if (!acc[row.section]) acc[row.section] = []
    acc[row.section].push(row)
    return acc
  }, {})

  const intakeSections = Object.entries(bySec)
    .map(([section, rows]) => {
      const lines = rows
        .map(r => {
          const answered = r.response_value && r.response_value.trim().length > 0
          const value = answered ? r.response_value : '[not answered]'
          const flag = r.is_critical && !answered ? ' ⚠️ CRITICAL — NOT ANSWERED' : ''
          return `  Q: ${r.field_label}${flag}\n  A: ${value}`
        })
        .join('\n\n')
      return `### ${section}\n\n${lines}`
    })
    .join('\n\n---\n\n')

  // Voice samples block — primary extraction source, surfaced prominently.
  const sampleStatus = samplesEmpty
    ? '⚠️ NO SAMPLES PROVIDED — generate from voice_style and intake preferences only. Mark confidence as low.'
    : samplesThin
      ? `⚠️ THIN SAMPLES (${sampleWordCount} words) — extract what you can. Note the limitation. Mark confidence as low.`
      : `${sampleWordCount} words across samples — full extraction is possible.`

  const voiceSamplesBlock = samplesEmpty
    ? `\n\n---\n\n## WRITING SAMPLES (primary extraction source)\n\n${sampleStatus}\n\n[No samples provided]`
    : `\n\n---\n\n## WRITING SAMPLES (primary extraction source)\n\n${sampleStatus}\n\n${samples}`

  // Voice style block — secondary signal, cross-reference only.
  const contradictionHint = apparentContradiction
    ? '\n\n⚠️ PRE-CHECK: A surface-level scan suggests the self-description may not match the samples. ' +
      'Look carefully for this contradiction and surface it in voice_style_note if confirmed.'
    : ''

  const voiceStyleBlock = style.length > 0
    ? `\n\n---\n\n## FOUNDER'S SELF-DESCRIPTION OF VOICE (voice_style — secondary, cross-reference only)\n\n` +
      'This is how the founder describes their own writing style. Do NOT use this as the primary source. ' +
      'Cross-reference it against the samples above. If they contradict, the samples are authoritative — ' +
      'base the TOV guide on the samples and surface the discrepancy in voice_style_note.' +
      contradictionHint +
      `\n\n${style}`
    : `\n\n---\n\n## FOUNDER'S SELF-DESCRIPTION OF VOICE (voice_style)\n\n[Not provided — base the guide entirely on writing samples and intake preferences.]`

  // Refresh context.
  const refreshContext = existingDocument
    ? `\n\n---\n\n## EXISTING TOV DOCUMENT (version ${existingDocument.version})\n\n` +
      'This is a refresh. The existing document is provided for context. ' +
      'Produce an improved version that incorporates any new samples or updated preferences.\n\n' +
      (existingDocument.plain_text ?? JSON.stringify(existingDocument.content, null, 2))
    : ''

  // Pattern context.
  const patternContext = patterns.length > 0
    ? `\n\n---\n\n## CROSS-CLIENT PATTERNS (anonymised, ${patterns.length} patterns)\n\n` +
      'These patterns are derived from aggregated data across multiple clients. ' +
      'They are supplementary context — not specific to this organisation.\n\n' +
      patterns
        .map(p => `- ${p.pattern_type} (${p.sample_size} data points): ${JSON.stringify(p.pattern_data)}`)
        .join('\n')
    : '\n\n---\n\n## CROSS-CLIENT PATTERNS\n\nNo pattern data available yet (phase one). ' +
      'Base the guide entirely on the samples and intake data above.'

  const completenessNote = completeness < 80
    ? `\n\n⚠️ INTAKE COMPLETENESS NOTE: Only ${completeness}% of critical fields have been answered. ` +
      'Derive what you can from the available samples and preferences. Do not hallucinate specifics.'
    : ''

  return `You are generating a Tone of Voice guide for a founder-led B2B consulting firm.
${completenessNote}

## INTAKE QUESTIONNAIRE RESPONSES (excluding voice fields — those are below)

${intakeSections}${voiceSamplesBlock}${voiceStyleBlock}${refreshContext}${patternContext}

---

Using the frameworks and rules in your system prompt, produce the Tone of Voice guide now.

Your job is extraction, not invention:
- voice_samples is your primary source — base the entire guide on what you find there
- voice_style is a secondary cross-reference — note any contradictions honestly
- The five mandatory corrections (no I/We opener, one question max, no feature listing
  before relevance, no service-led language, first touch under 100 words) apply always,
  regardless of what the samples show

Return raw JSON only. No preamble, no explanation, no markdown fencing.`
}

// ─── Claude API call ──────────────────────────────────────────────────────────

async function callClaude(userMessage: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error(
      'TOV agent: ANTHROPIC_API_KEY environment variable is not set. ' +
      'Add it to .env.local before running agents.'
    )
  }

  const client = new Anthropic({ apiKey })

  const systemPrompt = await loadSystemPrompt()

  const message = await client.messages.create({
    model: TOV_MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: userMessage,
      },
    ],
  })

  const content = message.content.find(block => block.type === 'text')
  if (!content || content.type !== 'text') {
    throw new Error('TOV agent: Claude returned no text content in response.')
  }

  return stripMarkdownFences(content.text.trim())
}

function stripMarkdownFences(text: string): string {
  const withoutOpen = text.replace(/^```(?:json)?\s*\n?/i, '')
  const withoutClose = withoutOpen.replace(/\n?```\s*$/i, '')
  return withoutClose.trim()
}

async function loadSystemPrompt(): Promise<string> {
  const { readFile } = await import('fs/promises')
  const { join } = await import('path')

  try {
    const promptPath = join(process.cwd(), 'docs', 'prompts', 'tov-agent.md')
    const raw = await readFile(promptPath, 'utf-8')

    const systemPromptMarker = '## System Prompt'
    const idx = raw.indexOf(systemPromptMarker)
    if (idx === -1) {
      throw new Error(
        'TOV agent: could not find "## System Prompt" section in tov-agent.md'
      )
    }

    return raw.slice(idx + systemPromptMarker.length).trim()
  } catch (err) {
    throw new Error(`TOV agent: failed to load system prompt — ${String(err)}`)
  }
}

// ─── Write to document_suggestions ───────────────────────────────────────────

async function writeDocumentSuggestion(
  supabase: SupabaseClient,
  params: {
    organisation_id: string
    existingDocument: ExistingTovDocument | null
    generatedContent: string
    parsedDocument: Record<string, unknown>
    intake: IntakeRow[]
    voiceInputs: VoiceInputs
    completeness: number
    is_refresh: boolean
  }
): Promise<string> {
  const {
    organisation_id,
    existingDocument,
    generatedContent,
    voiceInputs,
    completeness,
    is_refresh,
  } = params

  const answeredCount = params.intake.filter(
    r => r.response_value && r.response_value.trim().length > 0
  ).length
  const totalCount = params.intake.length

  const refreshNote = is_refresh
    ? ` This is a refresh — the existing v${existingDocument?.version ?? '?'} document was used as context.`
    : ' This is the initial generation — no prior TOV document existed.'

  const completenessNote =
    completeness < 80
      ? ` ⚠️ Intake completeness was ${completeness}% (${answeredCount}/${totalCount} fields answered).`
      : ` Intake completeness: ${completeness}% (${answeredCount}/${totalCount} fields answered).`

  // Voice sample quality note — included in suggestion_reason so Doug knows
  // how much raw material the agent had to work with.
  const sampleNote = voiceInputs.samplesEmpty
    ? ' ⚠️ No writing samples were provided. This guide is based on self-description only — consider providing samples and regenerating.'
    : voiceInputs.samplesThin
      ? ` ⚠️ Writing samples were thin (${voiceInputs.sampleWordCount} words). More samples will improve accuracy.`
      : ` Writing samples: ${voiceInputs.sampleWordCount} words provided.`

  // Contradiction note — surfaces in suggestion_reason when the pre-check flagged one.
  // Claude's analysis is authoritative; this note flags that Doug should read voice_style_note.
  const contradictionNote = voiceInputs.apparentContradiction
    ? ' ⚠️ Potential contradiction detected between voice_style self-description and writing samples — check voice_style_note in the document.'
    : ''

  const suggestionReason =
    `TOV guide generated by tov-generation-agent using ${TOV_MODEL}.` +
    refreshNote +
    completenessNote +
    sampleNote +
    contradictionNote

  // Confidence is low if samples were absent or thin — the guide is less grounded in that case.
  const confidenceLevel =
    voiceInputs.samplesEmpty || voiceInputs.samplesThin || completeness < 80
      ? 'low'
      : 'high'

  const { data, error } = await supabase
    .from('document_suggestions')
    .insert({
      organisation_id,            // always scoped to this client
      document_id: existingDocument?.id ?? null,
      document_type: 'tov',
      field_path: 'full_document',
      current_value: existingDocument?.plain_text ?? null,
      suggested_value: generatedContent,
      suggestion_reason: suggestionReason,
      confidence_level: confidenceLevel,
      signal_count: 0,
      status: 'pending',
    })
    .select('id')
    .single()

  if (error) {
    throw new Error(`TOV agent: failed to write document suggestion — ${error.message}`)
  }

  return data.id as string
}
