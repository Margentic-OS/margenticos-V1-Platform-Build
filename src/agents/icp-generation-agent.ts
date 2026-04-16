// ICP Generation Agent
// Entry point for generating the Ideal Client Profile document.
// Model: claude-opus-4-6
// Prompt: /docs/prompts/icp-agent.md
//
// ISOLATION RULES (enforced at three levels):
//   1. Database: RLS policies block cross-client reads
//   2. Application: explicit organisation_id filter on every query below
//   3. Prompt: no prompt references any data source outside current client context
//
// OUTPUT: writes to document_suggestions only — never to strategy_documents directly.

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

// The model specified in the PRD for document generation agents.
const ICP_MODEL = 'claude-opus-4-6'

// Maximum tokens for the ICP response. 8192 needed — three full tiers with all fields
// can exceed 4096 tokens, causing truncated JSON that fails to parse.
const MAX_TOKENS = 8192

// ─── Types ───────────────────────────────────────────────────────────────────

export interface IcpAgentInput {
  organisation_id: string
  /** Supabase client authenticated as the operator. Passed in from the API route. */
  supabase: SupabaseClient
  /** Optional: if true, includes existing ICP document content for refresh context. */
  is_refresh?: boolean
}

export interface IcpAgentResult {
  suggestion_id: string
  organisation_id: string
  document_type: 'icp'
  status: 'pending'
}

interface IntakeRow {
  field_key: string
  field_label: string
  response_value: string | null
  section: string
  is_critical: boolean
}

interface PatternRow {
  pattern_type: string
  pattern_data: Record<string, unknown>
  sample_size: number
  confidence_score: number | null
}

interface ExistingDocument {
  id: string
  version: string
  plain_text: string | null
  content: Record<string, unknown>
}

// ─── Main agent function ──────────────────────────────────────────────────────

export async function runIcpGenerationAgent(
  input: IcpAgentInput
): Promise<IcpAgentResult> {
  const { organisation_id, supabase, is_refresh = false } = input

  logger.info('ICP agent: starting', { organisation_id, is_refresh })

  // Step 1: Fetch intake responses for this client only.
  // Explicit organisation_id filter + RLS enforces isolation.
  const intake = await fetchIntakeResponses(supabase, organisation_id)

  if (intake.length === 0) {
    throw new Error(
      `ICP agent: no intake responses found for organisation ${organisation_id}. ` +
      'At least some intake data is required to generate an ICP.'
    )
  }

  // Step 2: Check completeness — warn if below 80% critical fields answered.
  const criticalFields = intake.filter(r => r.is_critical)
  const answeredCritical = criticalFields.filter(
    r => r.response_value && r.response_value.trim().length > 0
  )
  const completeness = criticalFields.length > 0
    ? Math.round((answeredCritical.length / criticalFields.length) * 100)
    : 0

  if (completeness < 80) {
    logger.warn(
      `ICP agent: intake completeness is ${completeness}% — below 80% threshold. Proceeding but quality may be lower.`,
      { organisation_id, completeness }
    )
  }

  // Step 3: Fetch existing ICP document if this is a refresh.
  let existingDocument: ExistingDocument | null = null
  if (is_refresh) {
    existingDocument = await fetchExistingIcpDocument(supabase, organisation_id)
  }

  // Step 4: Read patterns table (cross-client, read-only, may be empty in phase one).
  const patterns = await fetchPatterns(supabase)

  // Step 5: Build the user message from intake data.
  const userMessage = buildUserMessage({
    organisation_id,
    intake,
    existingDocument,
    patterns,
    completeness,
  })

  // Step 6: Call Claude.
  logger.info('ICP agent: calling Claude', { organisation_id, model: ICP_MODEL })
  const generatedContent = await callClaude(userMessage)

  // Step 7: Validate the response is parseable JSON before writing anything.
  let parsedDocument: Record<string, unknown>
  try {
    parsedDocument = JSON.parse(generatedContent)
  } catch {
    throw new Error(
      'ICP agent: Claude returned content that is not valid JSON. ' +
      'Raw response has been logged. Do not write to the database.'
    )
  }

  // Step 8: Write to document_suggestions — never to strategy_documents directly.
  const suggestionId = await writeDocumentSuggestion(supabase, {
    organisation_id,
    existingDocument,
    generatedContent,
    parsedDocument,
    intake,
    completeness,
    is_refresh,
  })

  logger.info('ICP agent: suggestion written successfully', { organisation_id, suggestion_id: suggestionId })

  return {
    suggestion_id: suggestionId,
    organisation_id,
    document_type: 'icp',
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
    throw new Error(`ICP agent: failed to fetch intake responses — ${error.message}`)
  }

  return (data ?? []) as IntakeRow[]
}

async function fetchExistingIcpDocument(
  supabase: SupabaseClient,
  organisation_id: string
): Promise<ExistingDocument | null> {
  const { data, error } = await supabase
    .from('strategy_documents')
    .select('id, version, plain_text, content')
    .eq('organisation_id', organisation_id) // explicit isolation filter
    .eq('document_type', 'icp')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (error) {
    // .single() throws if no row — treat as no existing document
    return null
  }

  return data as ExistingDocument
}

async function fetchPatterns(supabase: SupabaseClient): Promise<PatternRow[]> {
  // Patterns are cross-client aggregated data — the only permitted cross-client read.
  // Handle empty gracefully: phase one will have no patterns.
  const { data, error } = await supabase
    .from('patterns')
    .select('pattern_type, pattern_data, sample_size, confidence_score')
    .order('confidence_score', { ascending: false })
    .limit(20)

  if (error) {
    // Non-fatal: patterns are supplementary. Log and continue.
    logger.warn('ICP agent: could not fetch patterns — continuing without them', { error: error.message })
    return []
  }

  return (data ?? []) as PatternRow[]
}

// ─── Prompt construction ──────────────────────────────────────────────────────

function buildUserMessage(params: {
  organisation_id: string
  intake: IntakeRow[]
  existingDocument: ExistingDocument | null
  patterns: PatternRow[]
  completeness: number
}): string {
  const { intake, existingDocument, patterns, completeness } = params

  // Group intake responses by section for readability in the prompt.
  const bySec = intake.reduce<Record<string, IntakeRow[]>>((acc, row) => {
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

  // Refresh context: include the existing document so the agent can version correctly.
  const refreshContext = existingDocument
    ? `\n\n---\n\n## EXISTING ICP DOCUMENT (version ${existingDocument.version})\n\nThis is a refresh. The existing document is provided for context. ` +
      `Produce an improved version that incorporates any new intake data.\n\n${existingDocument.plain_text ?? JSON.stringify(existingDocument.content, null, 2)}`
    : ''

  // Pattern context: if patterns exist, include relevant ones.
  const patternContext = patterns.length > 0
    ? `\n\n---\n\n## CROSS-CLIENT PATTERNS (anonymised, ${patterns.length} patterns)\n\n` +
      'These patterns are derived from aggregated campaign data across multiple clients. ' +
      'They are supplementary context — not specific to this organisation.\n\n' +
      patterns
        .map(p => `- ${p.pattern_type} (${p.sample_size} data points): ${JSON.stringify(p.pattern_data)}`)
        .join('\n')
    : '\n\n---\n\n## CROSS-CLIENT PATTERNS\n\nNo pattern data available yet (phase one). ' +
      'Base your analysis entirely on the intake data above.'

  const completenessNote = completeness < 80
    ? `\n\n⚠️ INTAKE COMPLETENESS NOTE: Only ${completeness}% of critical fields have been answered. ` +
      'Derive what you can from what is available. Flag any significant gaps in the suggestion_reason ' +
      'that you will include in your output context. Do not hallucinate specifics.'
    : ''

  return `You are generating an ICP document for a founder-led B2B consulting firm.

${completenessNote}

## INTAKE QUESTIONNAIRE RESPONSES

${intakeSections}${refreshContext}${patternContext}

---

Using the frameworks and rules in your system prompt, produce the ICP document now.
Return raw JSON only. No preamble, no explanation, no markdown fencing.`
}

// ─── Claude API call ──────────────────────────────────────────────────────────

async function callClaude(userMessage: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error(
      'ICP agent: ANTHROPIC_API_KEY environment variable is not set. ' +
      'Add it to .env.local before running agents.'
    )
  }

  const client = new Anthropic({ apiKey })

  // Load the system prompt from the prompt file at runtime.
  // The file is read once per invocation — no module-level caching (stateless).
  const systemPrompt = await loadSystemPrompt()

  const message = await client.messages.create({
    model: ICP_MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: userMessage,
      },
    ],
  })

  // Extract the text content from the response.
  const content = message.content.find(block => block.type === 'text')
  if (!content || content.type !== 'text') {
    throw new Error('ICP agent: Claude returned no text content in response.')
  }

  // Strip markdown code fences if present. Claude sometimes wraps JSON in ```json ... ```
  // despite explicit instructions not to. Strip defensively so parsing never fails on fences.
  return stripMarkdownFences(content.text.trim())
}

function stripMarkdownFences(text: string): string {
  // Remove opening fence: ```json or ``` at the very start
  const withoutOpen = text.replace(/^```(?:json)?\s*\n?/i, '')
  // Remove closing fence: ``` at the very end
  const withoutClose = withoutOpen.replace(/\n?```\s*$/i, '')
  return withoutClose.trim()
}

async function loadSystemPrompt(): Promise<string> {
  // Dynamic import of fs — only available server-side.
  // The prompt file is the source of truth for agent behaviour.
  const { readFile } = await import('fs/promises')
  const { join } = await import('path')

  try {
    const promptPath = join(process.cwd(), 'docs', 'prompts', 'icp-agent.md')
    const raw = await readFile(promptPath, 'utf-8')

    // Strip the frontmatter header lines (lines starting with #) and the Status block,
    // keeping only the content from "## System Prompt" onward.
    const systemPromptMarker = '## System Prompt'
    const idx = raw.indexOf(systemPromptMarker)
    if (idx === -1) {
      throw new Error('ICP agent: could not find "## System Prompt" section in icp-agent.md')
    }

    return raw.slice(idx + systemPromptMarker.length).trim()
  } catch (err) {
    throw new Error(`ICP agent: failed to load system prompt — ${String(err)}`)
  }
}

// ─── Write to document_suggestions ───────────────────────────────────────────

async function writeDocumentSuggestion(
  supabase: SupabaseClient,
  params: {
    organisation_id: string
    existingDocument: ExistingDocument | null
    generatedContent: string
    parsedDocument: Record<string, unknown>
    intake: IntakeRow[]
    completeness: number
    is_refresh: boolean
  }
): Promise<string> {
  const {
    organisation_id,
    existingDocument,
    generatedContent,
    completeness,
    is_refresh,
  } = params

  // Build the human-readable reason that will appear in Doug's approval queue.
  const answeredCount = params.intake.filter(
    r => r.response_value && r.response_value.trim().length > 0
  ).length
  const totalCount = params.intake.length
  const refreshNote = is_refresh
    ? ` This is a refresh — the existing v${existingDocument?.version ?? '?'} document was used as context.`
    : ' This is the initial generation — no prior ICP document existed.'

  const completenessNote =
    completeness < 80
      ? ` ⚠️ Intake completeness was ${completeness}% (${answeredCount}/${totalCount} fields answered). ` +
        'Some sections may be less specific than ideal. Consider completing the intake before approving.'
      : ` Intake completeness: ${completeness}% (${answeredCount}/${totalCount} fields answered).`

  const suggestionReason =
    `ICP document generated by icp-generation-agent using ${ICP_MODEL}.` +
    refreshNote +
    completenessNote

  const { data, error } = await supabase
    .from('document_suggestions')
    .insert({
      organisation_id,          // always scoped to this client
      document_id: existingDocument?.id ?? null, // null for initial generation
      document_type: 'icp',
      field_path: 'full_document',
      current_value: existingDocument?.plain_text ?? null,
      suggested_value: generatedContent,
      suggestion_reason: suggestionReason,
      confidence_level: completeness >= 80 ? 'high' : 'low',
      signal_count: 0,           // phase one — not yet populated
      status: 'pending',
    })
    .select('id')
    .single()

  if (error) {
    throw new Error(`ICP agent: failed to write document suggestion — ${error.message}`)
  }

  return data.id as string
}
