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
//   Writing samples — primary extraction source, arriving by EITHER of two routes, which
//     are weighed identically. The agent derives vocabulary, rhythm, personality and
//     structure from them.
//       uploaded  — intake_files rows with file_purpose 'voice_sample'
//       pasted    — the intake answer under TYPED_VOICE_SAMPLES_FIELD_KEY
//     ('voice_samples' is a third, fully deprecated key with no live rows. Not read.)
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
import { mergeIntakeWithQuestions, TYPED_VOICE_SAMPLES_FIELD_KEY } from '@/lib/intake/questions'
import { logger } from '@/lib/logger'
import { assertNoUnsourcedVendorNames } from '@/lib/agents/vendor-name-gate'
import { startAgentRun } from '@/lib/agents/log-agent-run'
import { fetchWebsiteContext, formatWebsiteContextForPrompt, type WebsitePageContext } from '@/lib/agents/website-context'
import { scrubAITellsDeepExcluding, assertNoDashesExcluding } from '@/lib/style/customer-facing-style-rules'
import { buildRegenerationNotesBlock, buildRegenerationNotesReason, noteForVersionHistory, type RegenerationNotes } from '@/lib/agents/regeneration-notes'

// Fields in the TOV output that hold verbatim writing samples from the founder.
// These are passed through completely unchanged by both scrub and assert.
// Generated prose fields — including before_after_examples — get the hard throw-and-abort gate.
const TOV_VERBATIM_FIELDS: ReadonlySet<string> = new Set([
  'evidence',                 // voice_characteristics[*].evidence + what_this_voice_never_does[*].evidence
  'words_they_use',           // vocabulary.words_they_use — exact founder vocabulary extracted from samples
  'dominant_sentence_length', // sentence_mechanics fields embed inline verbatim quotes
  'fragment_usage',
  'punctuation_patterns',
  'opening_move_pattern',
])

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
  /** Optional: notes on the rejected suggestion this run replaces. See ADR-038. */
  regeneration_notes?: RegenerationNotes
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
  /** The form asks this question and this organisation has no row for it at all. */
  never_presented?: boolean
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

interface UploadedVoiceSample {
  filename: string
  text: string
}

// THE PASTE TAB WAS READ BY NOTHING UNTIL 2026-09-05. The sample count came from uploaded
// files only, so a client who pasted their writing was told their guide had no samples
// behind it, while the same prompt carried that writing as an ordinary intake answer.
// Two live organisations were in that state. Upload and paste are now weighed the same.

// Extracted voice inputs — pulled from intake_files (uploaded) and from intake itself.
// Upload and paste are two routes to the same thing and are weighed the same.
// voice_samples is a THIRD, fully deprecated key with no live rows; it stays excluded.
interface VoiceInputs {
  style: string
  sampleWordCount: number
  samplesEmpty: boolean
  samplesThin: boolean
  /** True if style description appears to contradict the samples, from either route. */
  apparentContradiction: boolean
  uploadedSamples: UploadedVoiceSample[]
  /** Writing pasted into intake. Empty string when none was given. */
  typedSamples: string
}

// ─── Main agent function ──────────────────────────────────────────────────────

export async function runTovGenerationAgent(
  input: TovAgentInput
): Promise<TovAgentResult> {
  const { organisation_id, supabase, is_refresh = false } = input
  const regeneration_notes = input.regeneration_notes

  logger.info('TOV agent: starting', { organisation_id, is_refresh })

  const agentRun = await startAgentRun({ organisation_id, agent_name: 'tov-generation' })

  const AGENT_TIMEOUT_MS = 240 * 1000
  let timeoutHandle: NodeJS.Timeout | null = null

  try {
    timeoutHandle = setTimeout(async () => {
      const msg = 'TOV agent: execution exceeded 240s timeout guard — failing gracefully'
      logger.error(msg, { organisation_id })
      await agentRun.fail(msg)
    }, AGENT_TIMEOUT_MS)

    // Step 1: Fetch intake responses for this client only.
  // Explicit organisation_id filter + RLS enforces isolation.
  const intake = await fetchIntakeResponses(supabase, organisation_id)

  if (intake.length === 0) {
    throw new Error(
      `TOV agent: no intake responses found for organisation ${organisation_id}. ` +
      'Intake data is required to generate a Tone of Voice guide.'
    )
  }

  // Step 2: Fetch uploaded voice sample files (extraction already done at upload time).
  const uploadedSamples = await fetchUploadedVoiceSamples(supabase, organisation_id)

  if (uploadedSamples.length > 0) {
    logger.info('TOV agent: found uploaded voice sample files', {
      organisation_id, count: uploadedSamples.length,
    })
  }

  // Step 3: Extract voice_samples and voice_style from intake.
  // Also incorporates any uploaded sample files found above.
  const voiceInputs = extractVoiceInputs(intake, uploadedSamples)

  if (voiceInputs.samplesEmpty) {
    logger.warn(
      'TOV agent: no writing samples from either route — generating from voice_style and intake preferences only. ' +
      'Confidence will be low.',
      { organisation_id }
    )
  } else if (voiceInputs.samplesThin) {
    logger.warn(
      `TOV agent: writing samples are thin (${voiceInputs.sampleWordCount} words) — ` +
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

  // Step 4: Check overall intake completeness — warn if below 80% critical fields answered.
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

  // Step 5b: Fetch website pages fetched at intake time.
  const websitePages = await fetchWebsiteContext(supabase, organisation_id, 'TOV agent')
  if (websitePages.length > 0) {
    logger.info('TOV agent: found website pages', { organisation_id, count: websitePages.length })
  }

  // Step 6: Build the user message from intake + voice inputs + website.
  // No web research step — TOV works from samples only.
  const userMessage = buildUserMessage({
    organisation_id,
    intake,
    voiceInputs,
    existingDocument,
    patterns,
    completeness,
    websitePages,
    regeneration_notes,
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

  // Gate: field-aware scrub. Verbatim founder writing fields (TOV_VERBATIM_FIELDS) pass
  // through completely unchanged. All other fields — including before_after_examples —
  // get the same hard throw-and-abort gate as ICP and positioning agents.
  const scrubbedDocument = scrubAITellsDeepExcluding(parsedDocument, 'tov-agent', TOV_VERBATIM_FIELDS)
  assertNoDashesExcluding(scrubbedDocument, 'tov-agent', TOV_VERBATIM_FIELDS)

  // Vendor-name gate. REPORT-ONLY until 2026-09-04: logs every hit with the
  // field and whether the input message supplied the name, and throws only in block mode.
  // The input message is literally what the model was given, which is what makes the
  // sourcedness test Rule 9's own test rather than a new one.
  assertNoUnsourcedVendorNames(scrubbedDocument, userMessage, {
    agent: 'tov-agent',
    organisation_id,
    document_type: 'tov',
  })
  const scrubbedContent = JSON.stringify(scrubbedDocument)

  // Step 9: Write to document_suggestions — never to strategy_documents directly.
  const suggestionId = await writeDocumentSuggestion(supabase, {
    organisation_id,
    existingDocument,
    generatedContent: scrubbedContent,
    parsedDocument: scrubbedDocument,
    intake,
    voiceInputs,
    completeness,
    is_refresh,
    regeneration_notes,
  })

  logger.info('TOV agent: suggestion written successfully', {
    organisation_id,
    suggestion_id: suggestionId,
  })

  await agentRun.complete(`suggestion_id: ${suggestionId}`)

  if (timeoutHandle) clearTimeout(timeoutHandle)

  return {
    suggestion_id: suggestionId,
    organisation_id,
    document_type: 'tov',
    status: 'pending',
  }

  } catch (err) {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    const message = err instanceof Error ? err.message : String(err)
    await agentRun.fail(message)
    throw err
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

  const rows = (data ?? []) as IntakeRow[]

  // An organisation with NO stored intake at all must still trip the caller's empty check,
  // so return early rather than handing it back a full set of unanswered questions.
  if (rows.length === 0) return []

  // Otherwise fill in every question the form asks that this organisation has no row for.
  // Without this the agent only ever sees questions the client was shown, so a question
  // added after they finished their intake is invisible here and the CRITICAL marker below
  // cannot fire on it. See src/lib/intake/questions.ts.
  return mergeIntakeWithQuestions(rows) as IntakeRow[]
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

async function fetchUploadedVoiceSamples(
  supabase: SupabaseClient,
  organisation_id: string
): Promise<UploadedVoiceSample[]> {
  const { data, error } = await supabase
    .from('intake_files')
    .select('original_filename, extracted_text')
    .eq('organisation_id', organisation_id)
    .eq('file_purpose', 'voice_sample')
    .eq('extraction_status', 'complete')

  if (error) {
    logger.warn('TOV agent: could not fetch uploaded voice samples — continuing without them', {
      error: error.message,
    })
    return []
  }

  return (data ?? []).map(row => ({
    filename: row.original_filename as string,
    text: (row.extracted_text ?? '') as string,
  })).filter(s => s.text.trim().length > 0)
}

// ─── Voice input extraction ───────────────────────────────────────────────────

// Pulls voice_samples and voice_style from intake and computes metadata about
// sample richness and potential self-description contradictions.
//
// Contradiction detection is a heuristic pre-check — it catches the clearest cases
// (e.g. founder says "direct and concise" but sample is over 200 words per paragraph).
// Claude's deeper analysis is the authoritative contradiction check.
function extractVoiceInputs(
  intake: IntakeRow[],
  uploadedSamples: UploadedVoiceSample[]
): VoiceInputs {
  const val = (key: string) =>
    intake.find(r => r.field_key === key)?.response_value?.trim() ?? ''

  const style = val('voice_style')

  // Pasted writing counts exactly as much as an uploaded file. Which route a client took
  // is a fact about the form, not about how much of their voice we have to work with.
  const typedSamples = val(TYPED_VOICE_SAMPLES_FIELD_KEY)

  const countWords = (text: string) =>
    text.split(/\s+/).filter(w => w.length > 0).length

  const sampleWordCount =
    uploadedSamples.reduce((sum, s) => sum + countWords(s.text), 0) +
    countWords(typedSamples)

  const samplesEmpty = sampleWordCount === 0
  const samplesThin  = !samplesEmpty && sampleWordCount < THIN_SAMPLE_WORD_THRESHOLD

  // Heuristic contradiction check across BOTH routes, for the same reason the count is.
  // These are signals, not definitive — Claude makes the authoritative call.
  let apparentContradiction = false
  if (!samplesEmpty && style.length > 0) {
    const styleLower    = style.toLowerCase()
    const allSampleText = [...uploadedSamples.map(s => s.text), typedSamples]
      .filter(t => t.trim().length > 0)
      .join('\n\n')
    const samplesLower  = allSampleText.toLowerCase()

    const claimsDirect   = styleLower.includes('direct') || styleLower.includes('concise') || styleLower.includes('brief')
    const sentences      = allSampleText.split(/[.!?]+/).filter(s => s.trim().length > 5)
    const avgSentenceLen = sentences.length > 0
      ? allSampleText.split(/\s+/).length / sentences.length
      : 0
    const samplesAreVerbose = avgSentenceLen > 25

    const claimsNoJargon    = styleLower.includes('no jargon') || styleLower.includes('plain') || styleLower.includes('simple')
    const jargonTerms       = ['leverage', 'synergy', 'scalable', 'robust', 'seamless', 'holistic', 'ecosystem']
    const samplesHaveJargon = jargonTerms.some(t => samplesLower.includes(t))

    const claimsWarm   = styleLower.includes('warm') || styleLower.includes('friendly') || styleLower.includes('personable')
    const samplesFormal = samplesLower.includes('dear ') || samplesLower.includes('please find') || samplesLower.includes('kind regards')

    if ((claimsDirect && samplesAreVerbose) ||
        (claimsNoJargon && samplesHaveJargon) ||
        (claimsWarm && samplesFormal)) {
      apparentContradiction = true
    }
  }

  return { style, sampleWordCount, samplesEmpty, samplesThin, apparentContradiction, uploadedSamples, typedSamples }
}

// ─── Prompt construction ──────────────────────────────────────────────────────

function buildUserMessage(params: {
  organisation_id: string
  intake: IntakeRow[]
  voiceInputs: VoiceInputs
  existingDocument: ExistingTovDocument | null
  patterns: PatternRow[]
  completeness: number
  websitePages: WebsitePageContext[]
  regeneration_notes: RegenerationNotes | undefined
}): string {
  const { intake, voiceInputs, existingDocument, patterns, completeness, websitePages } = params
  const { style, samplesEmpty, samplesThin, sampleWordCount, apparentContradiction, uploadedSamples, typedSamples } = voiceInputs

  // Group intake responses by section, excluding voice_style —
  // that is surfaced separately as a secondary cross-reference block.
  // voice_samples is excluded too: it is a fully deprecated field with no live rows.
  //
  // The pasted samples are excluded for a DIFFERENT reason: they are promoted into the
  // writing-samples block below. Without this they would appear twice in one prompt, once
  // as a sample and once as an ordinary answer. Before 2026-09-05 they appeared ONLY here,
  // which is how the model could quote writing the same prompt said did not exist.
  const bySec = intake.reduce<Record<string, IntakeRow[]>>((acc, row) => {
    if (row.field_key === 'voice_samples' || row.field_key === 'voice_style') return acc
    if (row.field_key === TYPED_VOICE_SAMPLES_FIELD_KEY) return acc
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
          const flag = r.is_critical && !answered
            ? (r.never_presented
                ? ' ⚠️ CRITICAL — NOT ANSWERED (added after this client completed intake, so they were never asked)'
                : ' ⚠️ CRITICAL — NOT ANSWERED')
            : ''
          return `  Q: ${r.field_label}${flag}\n  A: ${value}`
        })
        .join('\n\n')
      return `### ${section}\n\n${lines}`
    })
    .join('\n\n---\n\n')

  // Writing samples block — uploaded files and text pasted into intake, weighed the same.
  //
  // The absence wording says SAMPLES, never UPLOADS. It fires only when both routes are
  // empty, and it must keep firing then: an organisation that genuinely provided nothing
  // needs this warning, and silencing a true one is worse than the false one this replaced.
  const sampleSources = [
    ...uploadedSamples.map(s => ({ label: s.filename, text: s.text })),
    ...(typedSamples.trim().length > 0
      ? [{ label: 'Pasted into intake', text: typedSamples }]
      : []),
  ]

  const sampleScale = `${sampleWordCount} words across ${sampleSources.length} source(s)`

  const sampleStatus = samplesEmpty
    ? '⚠️ NO SAMPLES PROVIDED — generate from voice_style and intake preferences only. Mark confidence as low.'
    : samplesThin
      ? `⚠️ THIN SAMPLES (${sampleScale}) — extract what you can. Note the limitation. Mark confidence as low.`
      : `${sampleScale} — full extraction is possible.`

  const voiceSamplesBlock = samplesEmpty
    ? `\n\n---\n\n## WRITING SAMPLES (primary extraction source)\n\n${sampleStatus}\n\n[Nothing provided]`
    : '\n\n---\n\n## WRITING SAMPLES (primary extraction source)\n\n' +
      `${sampleStatus}\n\n` +
      sampleSources
        .map(s => `### ${s.label}\n\n${s.text}`)
        .join('\n\n---\n\n')

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

  const websiteBlock = formatWebsiteContextForPrompt(websitePages)

  return `You are generating a Tone of Voice guide for the B2B business described below.
Derive what this business does and who it sells to from the intake responses, voice samples
and website content in this message. Do not assume an industry, a service type, or a buyer
archetype that those sources do not support.
${completenessNote}

## INTAKE QUESTIONNAIRE RESPONSES (excluding voice fields — those are below)

${intakeSections}${voiceSamplesBlock}${voiceStyleBlock}${websiteBlock}${refreshContext}${patternContext}${buildRegenerationNotesBlock(params.regeneration_notes)}

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
    regeneration_notes: RegenerationNotes | undefined
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
    r => r.response_value && r.response_value.trim().length > 0 && r.is_critical
  ).length
  const totalCount = params.intake.filter(r => r.is_critical).length

  const refreshNote = is_refresh
    ? ` This is a refresh — the existing v${existingDocument?.version ?? '?'} document was used as context.`
    : ' This is the initial generation — no prior TOV document existed.'

  const completenessNote =
    completeness < 80
      ? ` ⚠️ Intake completeness was ${completeness}% (${answeredCount}/${totalCount} required fields answered).`
      : ` Intake completeness: ${completeness}% (${answeredCount}/${totalCount} required fields answered).`

  // Voice sample quality note — included in suggestion_reason so Doug knows
  // how much raw material the agent had to work with.
  const sampleSourceCount =
    voiceInputs.uploadedSamples.length + (voiceInputs.typedSamples.trim().length > 0 ? 1 : 0)

  const sampleNote = voiceInputs.samplesEmpty
    ? ' ⚠️ No writing samples provided. Guide is based on self-description only — add samples and regenerate for better accuracy.'
    : voiceInputs.samplesThin
      ? ` ⚠️ Thin samples — ${voiceInputs.sampleWordCount} words across ${sampleSourceCount} source(s). More samples will improve accuracy.`
      : ` Writing samples: ${sampleSourceCount} source(s), ${voiceInputs.sampleWordCount} words.`

  // Contradiction note — surfaces in suggestion_reason when the pre-check flagged one.
  // Claude's analysis is authoritative; this note flags that Doug should read voice_style_note.
  const contradictionNote = voiceInputs.apparentContradiction
    ? ' ⚠️ Potential contradiction detected between voice_style self-description and writing samples — check voice_style_note in the document.'
    : ''

  const suggestionReason =
    `TOV guide generated by tov-generation-agent using ${TOV_MODEL}.` +
    refreshNote +
    buildRegenerationNotesReason(params.regeneration_notes) +
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
      segment_id: null,           // TOV is org-level, not segment-scoped
      document_id: existingDocument?.id ?? null,
      document_type: 'tov',
      field_path: 'full_document',
      current_value: existingDocument?.plain_text ?? null,
      suggested_value: generatedContent,
      suggestion_reason: suggestionReason,
      confidence_level: confidenceLevel,
      signal_count: 0,
      status: 'pending',
      // What the version history shows for the version this becomes. See
      // noteForVersionHistory: without it five regenerations are indistinguishable.
      revision_note: noteForVersionHistory(params.regeneration_notes),
    })
    .select('id')
    .single()

  if (error) {
    // 23505 = unique_violation on document_suggestions_org_type_pending_unique.
    // A pending suggestion already exists for this org+type — idempotent no-op.
    if ((error as { code?: string }).code === '23505') {
      logger.info('TOV agent: duplicate pending suppressed by idempotency index', { organisation_id })
      const { data: existing } = await supabase
        .from('document_suggestions')
        .select('id')
        .eq('organisation_id', organisation_id)
        .eq('document_type', 'tov')
        .eq('status', 'pending')
        .single()
      return (existing?.id ?? null) as string
    }
    throw new Error(`TOV agent: failed to write document suggestion — ${error.message}`)
  }

  return data.id as string
}
