// Messaging Playbook Generation Agent
// Entry point for generating the Messaging Playbook.
// Model: claude-opus-4-6
// Prompt: /docs/prompts/messaging-agent.md
//
// ISOLATION RULES (enforced at three levels):
//   1. Database: RLS policies block cross-client reads
//   2. Application: explicit organisation_id filter on every query below
//   3. Prompt: no prompt references any data source outside current client context
//
// DEPENDENCIES — all three must exist and be active before this agent can run:
//   - ICP document     (strategy_documents WHERE document_type = 'icp' AND status = 'active')
//   - Positioning doc  (strategy_documents WHERE document_type = 'positioning' AND status = 'active')
//   - TOV guide        (strategy_documents WHERE document_type = 'tov' AND status = 'active')
//
//   This agent is the final document in the generation sequence. It synthesises all
//   three preceding documents into a practical, deploy-ready Messaging Playbook.
//   If any document is missing, the agent throws with a clear explanation.
//
// NO WEB SEARCH: the three strategy documents provide sufficient context.
//   Market intelligence has already been incorporated at the ICP and Positioning stages.
//
// OUTPUT: writes to document_suggestions only — never to strategy_documents directly.

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

const MESSAGING_MODEL = 'claude-opus-4-6'

// 8192 tokens — the Messaging Playbook is the largest output: full 4-email sequence
// with templates and examples, LinkedIn messages, subject line library (8+ options),
// opening line library (12+ options), CTA library (12+ options), objection responses.
const MAX_TOKENS = 8192

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MessagingAgentInput {
  organisation_id: string
  /** Supabase client authenticated as the operator. Passed in from the API route. */
  supabase: SupabaseClient
  /** Optional: if true, includes existing Messaging document content for refresh context. */
  is_refresh?: boolean
}

export interface MessagingAgentResult {
  suggestion_ids: string[]
  organisation_id: string
  document_type: 'messaging'
  status: 'pending'
}

// One email object as returned by Claude in the four-element array.
interface EmailRecord {
  sequence_position: number
  subject_line: string | null
  subject_char_count: number
  body: string
  word_count: number
  suggestion_reason?: string
}

interface IntakeRow {
  field_key: string
  field_label: string
  response_value: string | null
  section: string
  is_critical: boolean
}

// Represents any of the three required strategy documents.
interface StrategyDocument {
  id: string
  document_type: string
  version: string
  plain_text: string | null
  content: Record<string, unknown>
}

interface ExistingMessagingDocument {
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

// All three required predecessor documents, fetched together.
interface RequiredDocuments {
  icp: StrategyDocument
  positioning: StrategyDocument
  tov: StrategyDocument
}

// ─── Main agent function ──────────────────────────────────────────────────────

export async function runMessagingGenerationAgent(
  input: MessagingAgentInput
): Promise<MessagingAgentResult> {
  const { organisation_id, supabase, is_refresh = false } = input

  logger.info('Messaging agent: starting', { organisation_id, is_refresh })

  // Step 1: Fetch intake responses for this client only.
  const intake = await fetchIntakeResponses(supabase, organisation_id)

  if (intake.length === 0) {
    throw new Error(
      `Messaging agent: no intake responses found for organisation ${organisation_id}. ` +
      'Intake data is required to generate a Messaging Playbook.'
    )
  }

  // Step 2: Fetch all three required strategy documents.
  // Each must exist and be active — the messaging agent synthesises all three.
  // If any is missing, throw with a clear message naming which document is absent.
  const requiredDocs = await fetchRequiredDocuments(supabase, organisation_id)

  // Step 3: Check overall intake completeness.
  const criticalFields = intake.filter(r => r.is_critical)
  const answeredCritical = criticalFields.filter(
    r => r.response_value && r.response_value.trim().length > 0
  )
  const completeness = criticalFields.length > 0
    ? Math.round((answeredCritical.length / criticalFields.length) * 100)
    : 0

  if (completeness < 80) {
    logger.warn(
      `Messaging agent: intake completeness is ${completeness}% — below 80% threshold.`,
      { organisation_id, completeness }
    )
  }

  // Step 4: Fetch existing messaging document if this is a refresh.
  let existingDocument: ExistingMessagingDocument | null = null
  if (is_refresh) {
    existingDocument = await fetchExistingMessagingDocument(supabase, organisation_id)
  }

  // Step 5: Read patterns table (cross-client, read-only, may be empty in phase one).
  const patterns = await fetchPatterns(supabase)

  // Step 6: Build the user message.
  // The three strategy documents are included in full — they are the primary context.
  // No web research: market intelligence was incorporated at the ICP and Positioning stages.
  const userMessage = buildUserMessage({
    organisation_id,
    intake,
    requiredDocs,
    existingDocument,
    patterns,
    completeness,
  })

  // Step 7: Call Claude.
  logger.info('Messaging agent: calling Claude', { organisation_id, model: MESSAGING_MODEL })
  const generatedContent = await callClaude(userMessage)

  // Step 8: Parse and validate the four-email array.
  // Claude returns a JSON array of exactly 4 email objects per Rule 15 in the system prompt.
  let emails: EmailRecord[]
  try {
    const parsed: unknown = JSON.parse(generatedContent)
    if (!Array.isArray(parsed) || parsed.length !== 4) {
      throw new Error(
        `Expected an array of 4 emails, got ${Array.isArray(parsed) ? parsed.length : typeof parsed}`
      )
    }
    emails = parsed as EmailRecord[]
  } catch (err) {
    throw new Error(
      'Messaging agent: Claude returned invalid JSON. Expected array of 4 email objects. ' +
      String(err)
    )
  }

  // Step 9: Write 4 rows in a single batch insert — never to strategy_documents directly.
  // All four succeed or none are saved (Supabase insert is atomic for a single call).
  const suggestionIds = await writeDocumentSuggestions(supabase, {
    organisation_id,
    requiredDocs,
    existingDocument,
    emails,
    intake,
    completeness,
    is_refresh,
  })

  logger.info('Messaging agent: suggestions written successfully', {
    organisation_id,
    suggestion_ids: suggestionIds,
  })

  return {
    suggestion_ids: suggestionIds,
    organisation_id,
    document_type: 'messaging',
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
    throw new Error(`Messaging agent: failed to fetch intake responses — ${error.message}`)
  }

  return (data ?? []) as IntakeRow[]
}

async function fetchRequiredDocuments(
  supabase: SupabaseClient,
  organisation_id: string
): Promise<RequiredDocuments> {
  // Fetch all active strategy documents for this organisation in one query.
  // Then verify all three required types are present — if any are missing,
  // build a clear error message naming exactly which documents are absent.
  const { data, error } = await supabase
    .from('strategy_documents')
    .select('id, document_type, version, plain_text, content')
    .eq('organisation_id', organisation_id) // explicit isolation filter
    .in('document_type', ['icp', 'positioning', 'tov'])
    .eq('status', 'active')
    .order('created_at', { ascending: false })

  if (error) {
    throw new Error(`Messaging agent: failed to fetch strategy documents — ${error.message}`)
  }

  const docs = (data ?? []) as StrategyDocument[]

  // Deduplicate — take the most recent active document of each type.
  // The query is ordered by created_at DESC so the first match for each type wins.
  const byType: Partial<Record<string, StrategyDocument>> = {}
  for (const doc of docs) {
    if (!byType[doc.document_type]) {
      byType[doc.document_type] = doc
    }
  }

  const missing: string[] = []
  if (!byType['icp'])         missing.push('ICP document')
  if (!byType['positioning']) missing.push('Positioning document')
  if (!byType['tov'])         missing.push('Tone of Voice guide')

  if (missing.length > 0) {
    throw new Error(
      `Messaging agent: the following documents must be generated and approved before ` +
      `running the messaging agent: ${missing.join(', ')}. ` +
      `Run the missing agents first and approve the results in the dashboard.`
    )
  }

  return {
    icp:        byType['icp']!,
    positioning: byType['positioning']!,
    tov:        byType['tov']!,
  }
}

async function fetchExistingMessagingDocument(
  supabase: SupabaseClient,
  organisation_id: string
): Promise<ExistingMessagingDocument | null> {
  const { data, error } = await supabase
    .from('strategy_documents')
    .select('id, version, plain_text, content')
    .eq('organisation_id', organisation_id) // explicit isolation filter
    .eq('document_type', 'messaging')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (error) {
    return null
  }

  return data as ExistingMessagingDocument
}

async function fetchPatterns(supabase: SupabaseClient): Promise<PatternRow[]> {
  const { data, error } = await supabase
    .from('patterns')
    .select('pattern_type, pattern_data, sample_size, confidence_score')
    .order('confidence_score', { ascending: false })
    .limit(20)

  if (error) {
    logger.warn('Messaging agent: could not fetch patterns — continuing without them', {
      error: error.message,
    })
    return []
  }

  return (data ?? []) as PatternRow[]
}

// ─── Prompt construction ──────────────────────────────────────────────────────

function buildUserMessage(params: {
  organisation_id: string
  intake: IntakeRow[]
  requiredDocs: RequiredDocuments
  existingDocument: ExistingMessagingDocument | null
  patterns: PatternRow[]
  completeness: number
}): string {
  const { intake, requiredDocs, existingDocument, patterns, completeness } = params

  // Group intake by section.
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

  // Strategy documents — the primary context for this agent.
  // Each is included in full. The messaging agent synthesises all three.
  const formatDoc = (doc: StrategyDocument, label: string, guidance: string): string => {
    const body = doc.plain_text ?? JSON.stringify(doc.content, null, 2)
    return `\n\n---\n\n## ${label} (version ${doc.version})\n\n${guidance}\n\n${body}`
  }

  const icpBlock = formatDoc(
    requiredDocs.icp,
    'ICP DOCUMENT',
    'Use this to understand who the playbook is written for. ICP Tier 1 defines the hero. ' +
    'Their four_forces (push, pull, anxiety, habit) are the emotional raw material for opening lines and subject lines. ' +
    'Their triggers are the situations that make Email 1 land. Their switching_costs inform objection handling.'
  )

  const positioningBlock = formatDoc(
    requiredDocs.positioning,
    'POSITIONING DOCUMENT',
    'Use this for the core_message, value_themes, and key_messages. ' +
    'The moore_statement is the spine. The competitive_alternatives inform the cost-of-inaction framing. ' +
    'The white_space from competitive_landscape is what differentiates this firm in copy.'
  )

  const tovBlock = formatDoc(
    requiredDocs.tov,
    'TONE OF VOICE GUIDE',
    'Every word of copy must pass through this filter. ' +
    'Use the vocabulary.words_they_use list directly. ' +
    'Apply the vocabulary.structural_patterns to every email and LinkedIn message. ' +
    'The writing_rules section contains the five mandatory corrections — all apply here. ' +
    'The before_after_examples show the register. The do_dont_list is a copy checklist.'
  )

  // Refresh context.
  const refreshContext = existingDocument
    ? `\n\n---\n\n## EXISTING MESSAGING PLAYBOOK (version ${existingDocument.version})\n\n` +
      'This is a refresh. Review the existing playbook and produce an improved version. ' +
      'Preserve what works. Update what has been superseded by new strategy documents.\n\n' +
      (existingDocument.plain_text ?? JSON.stringify(existingDocument.content, null, 2))
    : ''

  const patternContext = patterns.length > 0
    ? `\n\n---\n\n## CROSS-CLIENT PATTERNS (anonymised, ${patterns.length} patterns)\n\n` +
      'Supplementary context only — not specific to this organisation.\n\n' +
      patterns
        .map(p => `- ${p.pattern_type} (${p.sample_size} data points): ${JSON.stringify(p.pattern_data)}`)
        .join('\n')
    : ''

  const completenessNote = completeness < 80
    ? `\n\n⚠️ INTAKE COMPLETENESS NOTE: Only ${completeness}% of critical fields answered. ` +
      'Derive what you can from the three strategy documents, which are the primary context. ' +
      'Do not hallucinate specifics.'
    : ''

  return `You are generating a Messaging Playbook for a founder-led B2B consulting firm.
${completenessNote}

The three strategy documents below are your primary context. They contain everything you need
to write copy that is specific, grounded, and consistent. Do not invent details not present in them.

## INTAKE QUESTIONNAIRE RESPONSES

${intakeSections}${icpBlock}${positioningBlock}${tovBlock}${refreshContext}${patternContext}

---

Using the frameworks and rules in your system prompt, produce the Messaging Playbook now.

Critical reminders:
- Write the core_message first — every piece of copy must trace back to it
- Email 1 is where 58% of replies come from — quality here is everything
- Word counts are hard caps: Email 1 ≤100 words, Email 2 ≤75, Email 3 ≤65, Email 4 ≤50
- Count every word. Include the accurate word_count in each email object.
- Every message must pass the TOV writing_rules — apply them before returning
- No I/We openers. One question per message. No service-led language.

Return raw JSON only. No preamble, no explanation, no markdown fencing.`
}

// ─── Claude API call ──────────────────────────────────────────────────────────

async function callClaude(userMessage: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error(
      'Messaging agent: ANTHROPIC_API_KEY environment variable is not set. ' +
      'Add it to .env.local before running agents.'
    )
  }

  const client = new Anthropic({ apiKey })

  const systemPrompt = await loadSystemPrompt()

  const message = await client.messages.create({
    model: MESSAGING_MODEL,
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
    throw new Error('Messaging agent: Claude returned no text content in response.')
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
    const promptPath = join(process.cwd(), 'docs', 'prompts', 'messaging-agent.md')
    const raw = await readFile(promptPath, 'utf-8')

    const systemPromptMarker = '## System Prompt'
    const idx = raw.indexOf(systemPromptMarker)
    if (idx === -1) {
      throw new Error(
        'Messaging agent: could not find "## System Prompt" section in messaging-agent.md'
      )
    }

    return raw.slice(idx + systemPromptMarker.length).trim()
  } catch (err) {
    throw new Error(`Messaging agent: failed to load system prompt — ${String(err)}`)
  }
}

// ─── Write to document_suggestions ───────────────────────────────────────────

// Writes four rows in a single batch insert — one per email in the sequence.
// All four rows share organisation_id and source document versions in their base reason.
// Each row's suggestion_reason also carries the per-email notes Claude wrote (imperfections,
// token warnings, TOV conflicts, threading notes for Emails 2 and 3).
async function writeDocumentSuggestions(
  supabase: SupabaseClient,
  params: {
    organisation_id: string
    requiredDocs: RequiredDocuments
    existingDocument: ExistingMessagingDocument | null
    emails: EmailRecord[]
    intake: IntakeRow[]
    completeness: number
    is_refresh: boolean
  }
): Promise<string[]> {
  const {
    organisation_id,
    requiredDocs,
    existingDocument,
    emails,
    completeness,
    is_refresh,
  } = params

  const answeredCount = params.intake.filter(
    r => r.response_value && r.response_value.trim().length > 0
  ).length
  const totalCount = params.intake.length

  const refreshNote = is_refresh
    ? ` This is a refresh — the existing v${existingDocument?.version ?? '?'} document was used as context.`
    : ' This is the initial generation — no prior Messaging Playbook existed.'

  const completenessNote =
    completeness < 80
      ? ` ⚠️ Intake completeness was ${completeness}% (${answeredCount}/${totalCount} fields answered).`
      : ` Intake completeness: ${completeness}% (${answeredCount}/${totalCount} fields answered).`

  // Record which versions of the three source documents were used.
  // This matters for refresh decisions — if any source document has been updated
  // since the playbook was generated, a refresh is warranted.
  const sourceVersions =
    ` Source documents used: ICP v${requiredDocs.icp.version}, ` +
    `Positioning v${requiredDocs.positioning.version}, ` +
    `TOV v${requiredDocs.tov.version}.`

  const baseReason =
    `Messaging Playbook generated by messaging-generation-agent using ${MESSAGING_MODEL}.` +
    refreshNote +
    completenessNote +
    sourceVersions

  const rows = emails.map(email => {
    // Combine the base run context with any per-email notes Claude produced.
    const perEmailNote = email.suggestion_reason
      ? ` ${email.suggestion_reason}`
      : ''

    return {
      organisation_id,
      document_id: existingDocument?.id ?? null,
      document_type: 'messaging',
      field_path: `email_${email.sequence_position}`,
      current_value: null as string | null,
      suggested_value: JSON.stringify(email),
      suggestion_reason: baseReason + perEmailNote,
      confidence_level: completeness >= 80 ? 'high' : 'low',
      signal_count: 0,
      status: 'pending',
      sequence_position: email.sequence_position,
    }
  })

  const { data, error } = await supabase
    .from('document_suggestions')
    .insert(rows)
    .select('id')

  if (error) {
    throw new Error(`Messaging agent: failed to write document suggestions — ${error.message}`)
  }

  return (data ?? []).map(row => row.id as string)
}
