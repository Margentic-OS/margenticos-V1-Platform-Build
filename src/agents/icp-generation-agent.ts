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
import { startAgentRun } from '@/lib/agents/log-agent-run'
import { runResearchQueries, formatResearchForPrompt, type ResearchBundle } from '@/lib/agents/tools/webSearch'
import { fetchWebsiteContext, formatWebsiteContextForPrompt, type WebsitePageContext } from '@/lib/agents/website-context'
import { scrubAITellsDeep, assertNoDashes } from '@/lib/style/customer-facing-style-rules'

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
  /** Segment this generation run is scoped to. NULL = org-level (should not occur for ICP). */
  segment_id?: string | null
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
  const { organisation_id, supabase, segment_id = null, is_refresh = false } = input

  logger.info('ICP agent: starting', { organisation_id, segment_id, is_refresh })

  const agentRun = await startAgentRun({ organisation_id, agent_name: 'icp-generation' })

  // Overall agent guard: fail gracefully at 240s (60s before Vercel's 300s ceiling)
  // to ensure agentRun.fail() can complete before the platform kills the function.
  const AGENT_TIMEOUT_MS = 240 * 1000
  let timeoutHandle: NodeJS.Timeout | null = null

  try {
    // Set up the timeout guard.
    timeoutHandle = setTimeout(async () => {
      const msg = 'ICP agent: execution exceeded 240s timeout guard — failing gracefully'
      logger.error(msg, { organisation_id })
      await agentRun.fail(msg)
    }, AGENT_TIMEOUT_MS)

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

  // Step 5: Fetch uploaded reference docs (ICP docs and case studies).
  const refDocs = await fetchUploadedRefDocs(supabase, organisation_id)
  if (refDocs.length > 0) {
    logger.info('ICP agent: found uploaded reference docs', {
      organisation_id, count: refDocs.length,
    })
  }

  // Step 5b: Fetch website pages fetched at intake time.
  const websitePages = await fetchWebsiteContext(supabase, organisation_id, 'ICP agent')
  if (websitePages.length > 0) {
    logger.info('ICP agent: found website pages', { organisation_id, count: websitePages.length })
  }

  // Step 6: Run web research — market intelligence to inform the ICP.
  // Queries are derived from the client's intake data, not hardcoded.
  // Research INFORMS the ICP — it does not override intake. Conflicts are flagged
  // in the affected field's own text, not silently resolved. Fails gracefully if unavailable.
  // Note: suggestion_reason is built in code further down and the model cannot write to it.
  logger.info('ICP agent: running web research', { organisation_id })
  const researchQueries = buildResearchQueries(intake)
  const research = await runResearchQueries(researchQueries)

  if (research.anyLimited) {
    logger.warn('ICP agent: some research queries returned limited results', {
      organisation_id,
      limitedNote: research.limitedNote,
    })
  }

  // Step 7: Build the user message from intake data + research + uploaded docs + website.
  const userMessage = buildUserMessage({
    organisation_id,
    intake,
    existingDocument,
    patterns,
    completeness,
    research,
    refDocs,
    websitePages,
  })

  // Step 7: Call Claude.
  logger.info('ICP agent: calling Claude', { organisation_id, model: ICP_MODEL })
  const generatedContent = await callClaude(userMessage)

  // Step 8: Validate the response is parseable JSON before writing anything.
  let parsedDocument: Record<string, unknown>
  try {
    parsedDocument = JSON.parse(generatedContent)
  } catch {
    throw new Error(
      'ICP agent: Claude returned content that is not valid JSON. ' +
      'Raw response has been logged. Do not write to the database.'
    )
  }

  // Gate: scrub em-dashes and AI tells from all prose string values in the document.
  // Operates on string values only — never changes JSON structure.
  const scrubbedDocument = scrubAITellsDeep(parsedDocument, 'icp-agent')
  assertNoDashes(scrubbedDocument, 'icp-agent')
  const scrubbedContent = JSON.stringify(scrubbedDocument)

  // Step 9: Write to document_suggestions — never to strategy_documents directly.
  const suggestionId = await writeDocumentSuggestion(supabase, {
    organisation_id,
    segment_id,
    existingDocument,
    generatedContent: scrubbedContent,
    parsedDocument: scrubbedDocument,
    intake,
    completeness,
    is_refresh,
    researchLimitedNote: research.limitedNote,
  })

  logger.info('ICP agent: suggestion written successfully', { organisation_id, suggestion_id: suggestionId })

  await agentRun.complete(`suggestion_id: ${suggestionId}`)

  if (timeoutHandle) clearTimeout(timeoutHandle)

  return {
    suggestion_id: suggestionId,
    organisation_id,
    document_type: 'icp',
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

interface UploadedRefDoc {
  filename: string
  purpose: string
  text: string
}

async function fetchUploadedRefDocs(
  supabase: SupabaseClient,
  organisation_id: string
): Promise<UploadedRefDoc[]> {
  const { data, error } = await supabase
    .from('intake_files')
    .select('original_filename, file_purpose, extracted_text')
    .eq('organisation_id', organisation_id)
    .in('file_purpose', ['icp_doc', 'case_study'])
    .eq('extraction_status', 'complete')

  if (error) {
    logger.warn('ICP agent: could not fetch uploaded reference docs — continuing without them', {
      error: error.message,
    })
    return []
  }

  return (data ?? []).map(row => ({
    filename: row.original_filename as string,
    purpose: row.file_purpose as string,
    text: (row.extracted_text ?? '') as string,
  })).filter(d => d.text.trim().length > 0)
}

// ─── Research query builder ───────────────────────────────────────────────────

// Condenses a free-text intake answer into a short search fragment.
// Search engines degrade badly on long natural-language strings, so we take the
// leading words only. Returns '' when the answer is too thin to be worth searching,
// which is what makes the caller fall back to a description-only query rather than
// to a hardcoded assumption about the client's industry.
function condense(text: string, maxWords: number): string {
  return text
    .replace(/["\u2018\u2019\u201c\u201d]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Intake answers are written in the first person ("We supply hot school meals to
    // primary schools"). The leading clause is noise in a search engine, so drop it
    // and keep the subject matter. Nothing here depends on the words that follow.
    .replace(/^(we|our team|our company|i)\s+(are|is|do|help|supply|provide|offer|sell|deliver|work with|specialise in|specialize in|run)\s+/i, '')
    .split(' ')
    .slice(0, maxWords)
    .join(' ')
    .trim()
}

// Derives 4 targeted search queries from the client's intake data.
// Queries cover: buyer pain points, buying triggers, buyer firmographics, and the
// client's competitive landscape. Each one informs a distinct part of the ICP.
//
// Every query interpolates the client's own intake text. Nothing here names an
// industry, a service type or a buyer archetype. An earlier version selected between
// two hardcoded consulting literals on each branch, so intake could not change the
// query: the .length checks gated which literal was used, and the intake values were
// never interpolated. That put MargenticOS's own competitive set into every client's
// research, whatever business the client was in.
// Exported for tests: the industry-agnosticism guarantee is only meaningful if
// something asserts that intake text actually reaches the query strings.
export function buildResearchQueries(intake: IntakeRow[]): string[] {
  const val = (key: string) =>
    intake.find(r => r.field_key === key)?.response_value?.trim() ?? ''

  const whatYouDo   = condense(val('company_what_you_do'), 12)
  const cloneClient = condense(val('clients_clone'), 12)
  const trigger     = condense(val('clients_trigger'), 12)
  const currency    = val('company_currency')

  // A soft geographic hint only. The ICP prompt's geography rules forbid inferring a
  // market from currency in the DOCUMENT; this narrows search results, nothing more.
  const geoHint = currency === 'GBP' ? 'UK'
    : currency === 'EUR' ? 'Europe'
    : currency === 'USD' ? 'US'
    : 'English-speaking markets'

  // The buyer we are researching. Falls back to the service description when the
  // ideal-client answer is thin, and to neither when both are thin.
  const buyer = cloneClient || whatYouDo

  // Query 1: Buyer pain points — the language real buyers use for the problem this
  // client solves. Grounds four_forces.push entries in market reality.
  const buyerPainQuery = buyer
    ? `${buyer} challenges problems pain points ${geoHint} 2025`
    : `B2B buyer challenges problems pain points ${geoHint} 2025`

  // Query 2: Trigger events — what business events cause this buyer to act?
  const triggerQuery = trigger
    ? `${buyer} ${trigger} buying trigger why now ${geoHint}`
    : `${buyer} buying trigger events when do they invest ${geoHint}`

  // Query 3: Buyer profile reality check — team size, revenue norms, stage language.
  const buyerProfileQuery = buyer
    ? `${buyer} typical company size revenue headcount profile ${geoHint} 2025`
    : `B2B buyer typical company size revenue headcount profile ${geoHint} 2025`

  // Query 4: Competitive landscape — how do others selling THIS CLIENT'S service to
  // THIS CLIENT'S buyer position themselves? Informs disqualifiers and switching costs.
  const competitorQuery = whatYouDo
    ? `${whatYouDo} providers competitors positioning ${geoHint} 2025`
    : `${buyer} suppliers competitors positioning ${geoHint} 2025`

  return [buyerPainQuery, triggerQuery, buyerProfileQuery, competitorQuery]
}

// ─── Prompt construction ──────────────────────────────────────────────────────

function buildUserMessage(params: {
  organisation_id: string
  intake: IntakeRow[]
  existingDocument: ExistingDocument | null
  patterns: PatternRow[]
  completeness: number
  research: ResearchBundle
  refDocs: UploadedRefDoc[]
  websitePages: WebsitePageContext[]
}): string {
  const { intake, existingDocument, patterns, completeness, research, refDocs, websitePages } = params

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
      'Derive what you can from what is available. Flag any significant gaps. Do not hallucinate specifics.'
    : ''

  // Research section: included only when searches returned usable results.
  // When research conflicts with intake data, your data quality rules apply:
  // flag the conflict rather than silently overriding either source.
  const researchSection = formatResearchForPrompt(research)
  const researchBlock = researchSection
    ? `\n\n---\n\n${researchSection}\n\n` +
      `RESEARCH WEIGHTING RULE: Use research to validate, enrich, and sharpen the language ` +
      `in the ICP. If research findings conflict with intake data, do NOT silently override ` +
      `intake. Instead, use the intake data as primary and state the conflict in the text of ` +
      `the field it affects, so a reader of the document can see it.`
    : '\n\n---\n\n## WEB RESEARCH\n\nNo usable research results available. ' +
      'Base your analysis entirely on intake data and framework logic.'

  const websiteBlock = formatWebsiteContextForPrompt(websitePages)

  return `You are generating an ICP document for the B2B business described below.
Derive what this business does, who it sells to, and the industry it operates in from the
intake responses, uploaded documents and website content in this message. Do not assume an
industry, a service type, or a buyer archetype that the intake does not support.
${completenessNote}

## INTAKE QUESTIONNAIRE RESPONSES

${intakeSections}${refDocs.length > 0
    ? '\n\n---\n\n## UPLOADED REFERENCE DOCUMENTS\n\n' +
      'The client has uploaded the following reference documents. ' +
      'Use them as primary source material alongside the intake responses above.\n\n' +
      refDocs.map(d =>
        `### ${d.filename} (${d.purpose === 'icp_doc' ? 'Existing ICP document' : 'Case study'})\n\n${d.text}`
      ).join('\n\n---\n\n')
    : ''}${websiteBlock}${researchBlock}${refreshContext}${patternContext}

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
    segment_id: string | null
    existingDocument: ExistingDocument | null
    generatedContent: string
    parsedDocument: Record<string, unknown>
    intake: IntakeRow[]
    completeness: number
    is_refresh: boolean
    researchLimitedNote: string
  }
): Promise<string> {
  const {
    organisation_id,
    segment_id,
    existingDocument,
    generatedContent,
    completeness,
    is_refresh,
    researchLimitedNote,
  } = params

  // Build the human-readable reason that will appear in Doug's approval queue.
  const answeredCount = params.intake.filter(
    r => r.response_value && r.response_value.trim().length > 0 && r.is_critical
  ).length
  const totalCount = params.intake.filter(r => r.is_critical).length
  const refreshNote = is_refresh
    ? ` This is a refresh — the existing v${existingDocument?.version ?? '?'} document was used as context.`
    : ' This is the initial generation — no prior ICP document existed.'

  const completenessNote =
    completeness < 80
      ? ` ⚠️ Intake completeness was ${completeness}% (${answeredCount}/${totalCount} required fields answered). ` +
        'Some sections may be less specific than ideal. Consider completing the intake before approving.'
      : ` Intake completeness: ${completeness}% (${answeredCount}/${totalCount} required fields answered).`

  const suggestionReason =
    `ICP document generated by icp-generation-agent using ${ICP_MODEL}.` +
    refreshNote +
    completenessNote +
    researchLimitedNote

  const { data, error } = await supabase
    .from('document_suggestions')
    .insert({
      organisation_id,          // always scoped to this client
      segment_id,               // segment this ICP was generated for
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
    // 23505 = unique_violation on document_suggestions_org_type_pending_unique.
    // A pending suggestion already exists for this org+type — idempotent no-op.
    if ((error as { code?: string }).code === '23505') {
      logger.info('ICP agent: duplicate pending suppressed by idempotency index', { organisation_id })
      const { data: existing } = await supabase
        .from('document_suggestions')
        .select('id')
        .eq('organisation_id', organisation_id)
        .eq('document_type', 'icp')
        .eq('status', 'pending')
        .single()
      return (existing?.id ?? null) as string
    }
    throw new Error(`ICP agent: failed to write document suggestion — ${error.message}`)
  }

  return data.id as string
}
