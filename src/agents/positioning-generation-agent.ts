// Positioning Generation Agent
// Entry point for generating the Positioning document.
// Model: claude-opus-4-6
// Prompt: /docs/prompts/positioning-agent.md
//
// ISOLATION RULES (enforced at three levels):
//   1. Database: RLS policies block cross-client reads
//   2. Application: explicit organisation_id filter on every query below
//   3. Prompt: no prompt references any data source outside current client context
//
// DEPENDENCY: requires an active ICP document for this organisation.
//   The ICP is the primary anchor for buyer language and four_forces.
//   If no ICP document exists, this agent throws — generate ICP first.
//
// OUTPUT: writes to document_suggestions only — never to strategy_documents directly.

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { assertNoUnsourcedVendorNames } from '@/lib/agents/vendor-name-gate'
import { startAgentRun } from '@/lib/agents/log-agent-run'
import { runResearchQueries, formatResearchForPrompt, type ResearchBundle } from '@/lib/agents/tools/webSearch'
import { fetchWebsiteContext, formatWebsiteContextForPrompt, type WebsitePageContext } from '@/lib/agents/website-context'
import { scrubAITellsDeep, assertNoDashes } from '@/lib/style/customer-facing-style-rules'
import {
  condense,
  intakeValue,
  resolveBuyerDescriptor,
  geographyFromIntake,
  usableDescriptor,
  MIN_PHRASE_WORDS,
  q,
  type BuyerDescriptorSource,
} from '@/lib/agents/research-descriptors'
import { buildRegenerationNotesBlock, buildRegenerationNotesReason, type RegenerationNotes } from '@/lib/agents/regeneration-notes'
import { projectIcpForDownstream } from '@/lib/agents/document-projection'

// The model specified in the PRD for document generation agents.
const POSITIONING_MODEL = 'claude-opus-4-6'

// 8192 tokens — the positioning document has many nested fields across all five
// Dunford components plus Moore statement, competitive landscape, and key messages.
const MAX_TOKENS = 8192

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PositioningAgentInput {
  organisation_id: string
  /** Supabase client authenticated as the operator. Passed in from the API route. */
  supabase: SupabaseClient
  /** Optional: if true, includes existing positioning document content for refresh context. */
  is_refresh?: boolean
  /** Optional: notes on the rejected suggestion this run replaces. See ADR-038. */
  regeneration_notes?: RegenerationNotes
}

export interface PositioningAgentResult {
  suggestion_id: string
  organisation_id: string
  document_type: 'positioning'
  status: 'pending'
}

interface IntakeRow {
  field_key: string
  field_label: string
  response_value: string | null
  section: string
  is_critical: boolean
}

interface IcpDocument {
  id: string
  version: string
  plain_text: string | null
  content: Record<string, unknown>
  status: string
}

interface ExistingPositioningDocument {
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

// ─── Main agent function ──────────────────────────────────────────────────────

export async function runPositioningGenerationAgent(
  input: PositioningAgentInput
): Promise<PositioningAgentResult> {
  const { organisation_id, supabase, is_refresh = false } = input
  const regeneration_notes = input.regeneration_notes

  logger.info('Positioning agent: starting', { organisation_id, is_refresh })

  const agentRun = await startAgentRun({ organisation_id, agent_name: 'positioning-generation' })

  const AGENT_TIMEOUT_MS = 240 * 1000
  let timeoutHandle: NodeJS.Timeout | null = null

  try {
    timeoutHandle = setTimeout(async () => {
      const msg = 'Positioning agent: execution exceeded 240s timeout guard — failing gracefully'
      logger.error(msg, { organisation_id })
      await agentRun.fail(msg)
    }, AGENT_TIMEOUT_MS)

    // Step 1: Fetch intake responses for this client only.
  // Explicit organisation_id filter + RLS enforces isolation.
  const intake = await fetchIntakeResponses(supabase, organisation_id)

  if (intake.length === 0) {
    throw new Error(
      `Positioning agent: no intake responses found for organisation ${organisation_id}. ` +
      'Intake data is required to generate a Positioning document.'
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
      `Positioning agent: intake completeness is ${completeness}% — below 80% threshold. Proceeding but quality may be lower.`,
      { organisation_id, completeness }
    )
  }

  // Step 3: Fetch the ICP document — required, not optional.
  // The ICP is the primary anchor for buyer language, four_forces, and best-fit characteristics.
  // Positioning cannot be generated without it.
  // fetchIcpDocument throws with a plain-English message if the document is missing or not approved.
  const icpDocument = await fetchIcpDocument(supabase, organisation_id)

  // Step 4: Fetch existing positioning document if this is a refresh.
  let existingDocument: ExistingPositioningDocument | null = null
  if (is_refresh) {
    existingDocument = await fetchExistingPositioningDocument(supabase, organisation_id)
  }

  // Step 5: Read patterns table (cross-client, read-only, may be empty in phase one).
  const patterns = await fetchPatterns(supabase)

  // Step 5b: Fetch website pages fetched at intake time.
  const websitePages = await fetchWebsiteContext(supabase, organisation_id, 'Positioning agent')
  if (websitePages.length > 0) {
    logger.info('Positioning agent: found website pages', { organisation_id, count: websitePages.length })
  }

  // Step 6: Run web research — competitor research is the primary use here.
  // Queries target: how competitors position, what buyers search for, what buyers say
  // in case studies, and what failure modes look like. Research INFORMS the positioning
  // — it does not override intake or the ICP. Fails gracefully if unavailable.
  logger.info('Positioning agent: running competitor research', { organisation_id })
  // A plan may decline to search. Same reasoning as the ICP agent: "research was skipped
  // because intake never described the service" and "research ran and found nothing" are
  // different facts about a document and only the first is actionable.
  const researchPlan = buildResearchPlan(intake)

  let research: ResearchBundle
  if (researchPlan.skipped) {
    logger.warn('Positioning agent: web research skipped, intake described no service', {
      organisation_id,
    })
    research = { results: [], anyLimited: false, limitedNote: '' }
  } else {
    research = await runResearchQueries(researchPlan.queries)
  }

  if (research.anyLimited) {
    logger.warn('Positioning agent: some research queries returned limited results', {
      organisation_id,
      limitedNote: research.limitedNote,
    })
  }

  // Step 7: Build the user message from intake + ICP + research + website.
  const userMessage = buildUserMessage({
    organisation_id,
    intake,
    icpDocument,
    existingDocument,
    patterns,
    completeness,
    research,
    websitePages,
    regeneration_notes,
  })

  // Step 8: Call Claude.
  logger.info('Positioning agent: calling Claude', { organisation_id, model: POSITIONING_MODEL })
  const generatedContent = await callClaude(userMessage)

  // Step 9: Validate the response is parseable JSON before writing anything.
  let parsedDocument: Record<string, unknown>
  try {
    parsedDocument = JSON.parse(generatedContent)
  } catch {
    throw new Error(
      'Positioning agent: Claude returned content that is not valid JSON. ' +
      'Raw response has been logged. Do not write to the database.'
    )
  }

  // Gate: scrub em-dashes and AI tells from all prose string values in the document.
  // Operates on string values only — never changes JSON structure.
  const scrubbedDocument = scrubAITellsDeep(parsedDocument, 'positioning-agent')
  assertNoDashes(scrubbedDocument, 'positioning-agent')

  // Vendor-name gate. REPORT-ONLY until 2026-09-04: logs every hit with the
  // field and whether the input message supplied the name, and throws only in block mode.
  // The input message is literally what the model was given, which is what makes the
  // sourcedness test Rule 9's own test rather than a new one.
  assertNoUnsourcedVendorNames(scrubbedDocument, userMessage, {
    agent: 'positioning-agent',
    organisation_id,
    document_type: 'positioning',
  })
  const scrubbedContent = JSON.stringify(scrubbedDocument)

  // Step 10: Write to document_suggestions — never to strategy_documents directly.
  const suggestionId = await writeDocumentSuggestion(supabase, {
    organisation_id,
    icpDocument,
    existingDocument,
    generatedContent: scrubbedContent,
    parsedDocument: scrubbedDocument,
    intake,
    completeness,
    is_refresh,
    researchLimitedNote: researchPlan.skipReason || research.limitedNote,
    regeneration_notes,
  })

  logger.info('Positioning agent: suggestion written successfully', {
    organisation_id,
    suggestion_id: suggestionId,
  })

  await agentRun.complete(`suggestion_id: ${suggestionId}`)

  if (timeoutHandle) clearTimeout(timeoutHandle)

  return {
    suggestion_id: suggestionId,
    organisation_id,
    document_type: 'positioning',
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
    throw new Error(`Positioning agent: failed to fetch intake responses — ${error.message}`)
  }

  return (data ?? []) as IntakeRow[]
}

async function fetchIcpDocument(
  supabase: SupabaseClient,
  organisation_id: string
): Promise<IcpDocument> {
  // Fetch the most recent ICP document for this organisation regardless of status,
  // then check status explicitly so we can give a specific error message.
  // Explicit organisation_id filter + RLS enforces isolation.
  const { data, error } = await supabase
    .from('strategy_documents')
    .select('id, version, plain_text, content, status')
    .eq('organisation_id', organisation_id) // explicit isolation filter
    .eq('document_type', 'icp')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    throw new Error(`Positioning agent: failed to fetch ICP document — ${error.message}`)
  }

  if (!data) {
    throw new Error(
      'Positioning agent: no ICP document found for this organisation. ' +
      'Run the ICP agent first and approve the result in the dashboard before running the positioning agent.'
    )
  }

  if (data.status !== 'active') {
    throw new Error(
      `Positioning agent: ICP document exists but has status "${data.status}". ` +
      'Approve the ICP document in the dashboard before running the positioning agent.'
    )
  }

  return data as IcpDocument
}

async function fetchExistingPositioningDocument(
  supabase: SupabaseClient,
  organisation_id: string
): Promise<ExistingPositioningDocument | null> {
  const { data, error } = await supabase
    .from('strategy_documents')
    .select('id, version, plain_text, content')
    .eq('organisation_id', organisation_id) // explicit isolation filter
    .eq('document_type', 'positioning')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (error) {
    return null
  }

  return data as ExistingPositioningDocument
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
    logger.warn('Positioning agent: could not fetch patterns — continuing without them', {
      error: error.message,
    })
    return []
  }

  return (data ?? []) as PatternRow[]
}

// ─── Research query builder ───────────────────────────────────────────────────

// PORTED FROM THE ICP AGENT, 2026-08-29. See ADR-044 and ADR-045.
//
// This builder was untouched from the start of the project until now, while the ICP
// builder was fixed twice. The descriptor rules, the geography rule and the query
// assembly all live in @/lib/agents/research-descriptors so the two cannot diverge again.
//
// WHAT IS DIFFERENT HERE, and it is why this was a separate change rather than the same
// one. Three of the four ICP queries are about the BUYER. Three of the four queries below
// are about the CLIENT'S OWN SERVICE: who else sells this, what do their case studies say,
// what do buyers complain about. For those, `company_what_you_do` is the correct input and
// was never the bug. Only query 2 asks about the buyer, and only query 2 needed the buyer
// fix. All four needed the geography fix.

export interface PositioningResearchPlan {
  /** The queries to run. Empty exactly when skipped is true. */
  queries: string[]
  /** True when intake described no service, so nothing worth searching exists. */
  skipped: boolean
  /** Operator-facing explanation, appended to suggestion_reason. '' when not skipped. */
  skipReason: string
  /** Where the buyer descriptor for query 2 came from. */
  buyerSource: BuyerDescriptorSource
}

// Derives up to 4 targeted search queries from the client's intake data, or declines to.
//
// Every query interpolates the client's own intake text. Nothing here names an industry,
// a service type or a buyer archetype.
export function buildResearchPlan(intake: IntakeRow[]): PositioningResearchPlan {
  const val = (key: string) => intakeValue(intake, key)

  // What this client sells. The subject of three of the four queries.
  //
  // THE offer_deliverables FALLBACK IS DELETED, not relaxed. It read
  // `whatYouDo || offer || buyer`, and measured across all five live organisations
  // `offer_deliverables` is an OUTCOME every time: "A qualified meeting in the diary that
  // flows into pipeline and drives", "contractual obligation", "To get a better overall
  // mattress, lower infection rates". Searching an outcome phrase for competitor
  // positioning returns nothing about the category, and it shipped as the service
  // descriptor for the one organisation whose service description is empty. A field that
  // answers a different question is not a fallback, it is the same defect as the ICP
  // builder falling back from the buyer to the service.
  // MIN_PHRASE_WORDS, not the prose floor: this is a category name, and "industrial
  // fasteners" is two words and perfectly searchable.
  const service = usableDescriptor(condense(val('company_what_you_do'), 12), MIN_PHRASE_WORDS)

  // NO SERVICE, NO RESEARCH. Three of the four queries have nothing to ask about without
  // it, and the fourth is only useful alongside them. The pre-port code substituted the
  // literal "B2B service providers" and searched anyway, which returns generic results
  // grounded in nothing about this client and reads exactly like research that worked.
  if (!service) {
    return {
      queries: [],
      skipped: true,
      buyerSource: 'none',
      skipReason:
        ' ⚠️ Web research was SKIPPED, not attempted and failed. The intake did not ' +
        'describe what this business sells in a form that can be searched, so there was ' +
        'no category to research competitors, case studies or complaints in. Every ' +
        'section below comes from intake and framework logic only, with no live market ' +
        'data. Regenerating without changing the intake will skip research again.',
    }
  }

  // The buyer, for query 2 only. Same resolution the ICP agent uses.
  const buyer = resolveBuyerDescriptor(intake)

  // The client's own domain, not their currency. Currency spans twenty-odd countries and
  // CLAUDE.md's geography rule forbids the inference. See ADR-043.
  const geoHint = geographyFromIntake(val('company_url') || val('assets_website'))

  // Query 1: Competitor positioning — what do others selling this claim?
  const competitorPositioningQuery = q(
    service, 'providers positioning messaging claims', geoHint, '2025')

  // Query 2: Buyer search language — how do buyers describe what they want?
  // The only buyer-facing query here, and the only one that needed the descriptor fix.
  const buyerSearchQuery = buyer.text
    ? q(buyer.text, '"looking for" OR "need help with"', service, geoHint, '2025')
    : q(service, 'buyer search intent category language', geoHint, '2025')

  // Query 3: Case study and review language — what do satisfied buyers say?
  const caseStudyQuery = q(service, 'case study results testimonial review', geoHint, '2025')

  // Query 4: Failure modes and white space — what frustrations do buyers voice?
  const failureModeQuery = q(
    service, '"didn\'t work" OR "failed" OR "disappointed" review complaints', '2025')

  return {
    queries: [competitorPositioningQuery, buyerSearchQuery, caseStudyQuery, failureModeQuery],
    skipped: false,
    skipReason: '',
    buyerSource: buyer.source,
  }
}


// ─── Prompt construction ──────────────────────────────────────────────────────

function buildUserMessage(params: {
  organisation_id: string
  intake: IntakeRow[]
  icpDocument: IcpDocument
  existingDocument: ExistingPositioningDocument | null
  patterns: PatternRow[]
  completeness: number
  research: ResearchBundle
  websitePages: WebsitePageContext[]
  regeneration_notes: RegenerationNotes | undefined
}): string {
  const { intake, icpDocument, existingDocument, patterns, completeness, research, websitePages } = params

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

  // ICP document: the primary anchor for this analysis.
  // Include in full so the agent can read buyer language, four_forces, and tiers directly.
  // Projected, not raw. The ICP carries operator-facing keys (unresolved_fields, and Rule 9
  // Tier Two flagged claims) that must not reach a document-writing prompt. plain_text is
  // NULL on every row, so the stringify branch was the real path and it passed everything.
  const icpContent = JSON.stringify(projectIcpForDownstream(icpDocument.content), null, 2)

  const icpBlock = `\n\n---\n\n## ICP DOCUMENT (version ${icpDocument.version}) — PRIMARY ANCHOR\n\n` +
    'This is the approved ICP document for this organisation. ' +
    'It is the primary source of truth for buyer language, four_forces, best-fit characteristics, ' +
    'and who not to target. Do not contradict it. If any intake data conflicts with the ICP, ' +
    'use the ICP as primary and note the discrepancy.\n\n' +
    icpContent

  // Refresh context: include the existing positioning document if this is a refresh.
  const refreshContext = existingDocument
    ? `\n\n---\n\n## EXISTING POSITIONING DOCUMENT (version ${existingDocument.version})\n\n` +
      'This is a refresh. The existing document is provided for context. ' +
      'Produce an improved version that incorporates new intake data and any updated ICP context.\n\n' +
      (existingDocument.plain_text ?? JSON.stringify(existingDocument.content, null, 2))
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
      'Base your analysis entirely on the intake data and ICP document above.'

  const completenessNote = completeness < 80
    ? `\n\n⚠️ INTAKE COMPLETENESS NOTE: Only ${completeness}% of critical fields have been answered. ` +
      'Derive what you can from what is available, anchoring on the ICP document for buyer context. ' +
      'Flag any significant gaps. Do not hallucinate specifics.'
    : ''

  // Research section: competitor research is the primary purpose here.
  // Conflicts with intake or ICP are flagged, not silently resolved.
  const researchSection = formatResearchForPrompt(research)
  const researchBlock = researchSection
    ? `\n\n---\n\n${researchSection}\n\n` +
      'RESEARCH WEIGHTING RULE: Use competitor research to sharpen unique_attributes and ' +
      'competitive_landscape. Use buyer language from case studies to enrich value_themes. ' +
      'If research conflicts with intake or ICP data, do NOT silently override — ' +
      'use intake and ICP as primary and note the conflict.'
    : '\n\n---\n\n## WEB RESEARCH\n\nNo usable research results available. ' +
      'Derive competitive_landscape from intake data and framework logic. ' +
      'Do not fabricate competitor names — use types (e.g. "generalist outbound agencies") instead.'

  const websiteBlock = formatWebsiteContextForPrompt(websitePages)

  return `You are generating a Positioning document for the B2B business described below.
Derive what this business does, who it sells to, and the industry it operates in from the
intake responses, the ICP document and the website content in this message. Do not assume an
industry, a service type, or a buyer archetype that those sources do not support.
${completenessNote}

## INTAKE QUESTIONNAIRE RESPONSES

${intakeSections}${websiteBlock}${researchBlock}${icpBlock}${refreshContext}${patternContext}${buildRegenerationNotesBlock(params.regeneration_notes)}

---

Using the frameworks and rules in your system prompt, produce the Positioning document now.
The ICP document above is your primary anchor — every element of this Positioning document
must be consistent with the buyer described in ICP Tier 1.
Return raw JSON only. No preamble, no explanation, no markdown fencing.`
}

// ─── Claude API call ──────────────────────────────────────────────────────────

async function callClaude(userMessage: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error(
      'Positioning agent: ANTHROPIC_API_KEY environment variable is not set. ' +
      'Add it to .env.local before running agents.'
    )
  }

  const client = new Anthropic({ apiKey })

  const systemPrompt = await loadSystemPrompt()

  const message = await client.messages.create({
    model: POSITIONING_MODEL,
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
    throw new Error('Positioning agent: Claude returned no text content in response.')
  }

  // Strip markdown code fences if present. Claude sometimes wraps JSON in ```json ... ```
  // despite explicit instructions not to. Strip defensively so parsing never fails on fences.
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
    const promptPath = join(process.cwd(), 'docs', 'prompts', 'positioning-agent.md')
    const raw = await readFile(promptPath, 'utf-8')

    const systemPromptMarker = '## System Prompt'
    const idx = raw.indexOf(systemPromptMarker)
    if (idx === -1) {
      throw new Error(
        'Positioning agent: could not find "## System Prompt" section in positioning-agent.md'
      )
    }

    return raw.slice(idx + systemPromptMarker.length).trim()
  } catch (err) {
    throw new Error(`Positioning agent: failed to load system prompt — ${String(err)}`)
  }
}

// ─── Write to document_suggestions ───────────────────────────────────────────

async function writeDocumentSuggestion(
  supabase: SupabaseClient,
  params: {
    organisation_id: string
    icpDocument: IcpDocument
    existingDocument: ExistingPositioningDocument | null
    generatedContent: string
    parsedDocument: Record<string, unknown>
    intake: IntakeRow[]
    completeness: number
    is_refresh: boolean
    researchLimitedNote: string
    regeneration_notes: RegenerationNotes | undefined
  }
): Promise<string> {
  const {
    organisation_id,
    icpDocument,
    existingDocument,
    generatedContent,
    completeness,
    is_refresh,
    researchLimitedNote,
  } = params

  const answeredCount = params.intake.filter(
    r => r.response_value && r.response_value.trim().length > 0 && r.is_critical
  ).length
  const totalCount = params.intake.filter(r => r.is_critical).length

  const refreshNote = is_refresh
    ? ` This is a refresh — the existing v${existingDocument?.version ?? '?'} document was used as context.`
    : ' This is the initial generation — no prior Positioning document existed.'

  const completenessNote =
    completeness < 80
      ? ` ⚠️ Intake completeness was ${completeness}% (${answeredCount}/${totalCount} required fields answered). ` +
        'Some sections may be less specific than ideal. Consider completing the intake before approving.'
      : ` Intake completeness: ${completeness}% (${answeredCount}/${totalCount} required fields answered).`

  const suggestionReason =
    `Positioning document generated by positioning-generation-agent using ${POSITIONING_MODEL}. ` +
    `ICP document v${icpDocument.version} used as primary anchor.` +
    refreshNote +
    buildRegenerationNotesReason(params.regeneration_notes) +
    completenessNote +
    researchLimitedNote

  const { data, error } = await supabase
    .from('document_suggestions')
    .insert({
      organisation_id,            // always scoped to this client
      segment_id: null,           // positioning is org-level, not segment-scoped
      document_id: existingDocument?.id ?? null, // null for initial generation
      document_type: 'positioning',
      field_path: 'full_document',
      current_value: existingDocument?.plain_text ?? null,
      suggested_value: generatedContent,
      suggestion_reason: suggestionReason,
      confidence_level: completeness >= 80 ? 'high' : 'low',
      signal_count: 0,             // phase one — not yet populated
      status: 'pending',
    })
    .select('id')
    .single()

  if (error) {
    // 23505 = unique_violation on document_suggestions_org_type_pending_unique.
    // A pending suggestion already exists for this org+type — idempotent no-op.
    if ((error as { code?: string }).code === '23505') {
      logger.info('Positioning agent: duplicate pending suppressed by idempotency index', { organisation_id })
      const { data: existing } = await supabase
        .from('document_suggestions')
        .select('id')
        .eq('organisation_id', organisation_id)
        .eq('document_type', 'positioning')
        .eq('status', 'pending')
        .single()
      return (existing?.id ?? null) as string
    }
    throw new Error(`Positioning agent: failed to write document suggestion — ${error.message}`)
  }

  return data.id as string
}
