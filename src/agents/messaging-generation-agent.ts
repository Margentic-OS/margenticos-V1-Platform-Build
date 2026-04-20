// Messaging Playbook Generation Agent
// Entry point for generating the Messaging Playbook.
// Model: claude-sonnet-4-6 (see ADR-013 — revert to claude-opus-4-6 on stable connection)
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
// OUTPUT: Generates four distinct sequence variants (A, B, C, D) per ADR-014.
//   Writes a single row to document_suggestions with suggested_value:
//   { variants: { A: { emails: [...] }, B: { emails: [...] }, ... } }
//   Each variant that passes the post-processor gate is stored.
//   Variants that fail are flagged in the suggestion_reason; other variants are unaffected.

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { startAgentRun } from '@/lib/agents/log-agent-run'

const MESSAGING_MODEL = 'claude-sonnet-4-6' // TEST ONLY — revert to claude-opus-4-6 for production (ADR-013)

// 4 variants × 4 emails each — increase tokens to accommodate the larger output.
const MAX_TOKENS = 16384

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MessagingAgentInput {
  organisation_id: string
  /** Supabase client authenticated as the operator. Passed in from the API route. */
  supabase: SupabaseClient
  /** Optional: if true, includes existing Messaging document content for refresh context. */
  is_refresh?: boolean
}

export interface MessagingAgentResult {
  suggestion_id: string
  organisation_id: string
  document_type: 'messaging'
  status: 'pending'
  variants_generated: number
  variants_failed: string[]
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

interface VariantFailure {
  variant: string
  violations: ValidationViolation[]
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
  status: string
}

// Validated pre-flight context — org name, sender first name, prospect company name.
// These are required for email generation. Missing any of them aborts the run.
interface PreflightContext {
  org_name: string
  sender_first_name: string
  company_name: string
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

  // Start agent run logging — every run is recorded to agent_runs table.
  const agentRun = await startAgentRun({
    client_id: organisation_id,
    agent_name: 'messaging-generation',
  })

  try {
    // Step 1: Fetch intake responses for this client only.
    const intake = await fetchIntakeResponses(supabase, organisation_id)

    if (intake.length === 0) {
      throw new Error(
        `Messaging agent: no intake responses found for organisation ${organisation_id}. ` +
        'Intake data is required to generate a Messaging Playbook.'
      )
    }

    // Step 2: Pre-flight checks — verify required name fields before any generation work.
    const preflight = await runPreflightChecks(supabase, organisation_id, intake)

    // Step 3: Fetch all three required strategy documents.
    const requiredDocs = await fetchRequiredDocuments(supabase, organisation_id)

    // Step 4: Check overall intake completeness.
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

    // Step 5: Fetch existing messaging document if this is a refresh.
    let existingDocument: ExistingMessagingDocument | null = null
    if (is_refresh) {
      existingDocument = await fetchExistingMessagingDocument(supabase, organisation_id)
    }

    // Step 6: Read patterns table (cross-client, read-only, may be empty in phase one).
    const patterns = await fetchPatterns(supabase)

    // Step 7: Build the user message requesting four variants.
    const userMessage = buildUserMessage({
      organisation_id,
      intake,
      requiredDocs,
      existingDocument,
      patterns,
      completeness,
      preflight,
    })

    // Step 8: Call Claude.
    logger.info('Messaging agent: calling Claude for four variants', {
      organisation_id,
      model: MESSAGING_MODEL,
    })
    const generatedContent = await callClaude(userMessage)

    // Step 9: Parse the four-variant structure.
    // Expected: { variants: { A: { emails: [...] }, B: { emails: [...] }, C: {...}, D: {...} } }
    const rawVariants = parseVariantsFromClaude(generatedContent)

    // Step 10: Post-process each variant independently.
    // Em-dash auto-fix + 10-rule gate runs per variant.
    // A failing variant is flagged and excluded — passing variants proceed to storage.
    const { passedVariants, variantFailures } = await processAllVariants(
      rawVariants,
      preflight.sender_first_name,
      organisation_id
    )

    if (Object.keys(passedVariants).length === 0) {
      const failSummary = variantFailures
        .map(f => `Variant ${f.variant}: ${f.violations.map(v => `Email ${v.email}: ${v.issue}`).join('; ')}`)
        .join(' | ')
      await agentRun.fail(`All 4 variants failed post-processing validation. ${failSummary}`)
      throw new MessagingValidationError(
        variantFailures.flatMap(f => f.violations),
        Object.values(rawVariants).flat()
      )
    }

    // Step 11: Write validated variants to document_suggestions.
    const suggestionId = await writeDocumentSuggestion(supabase, {
      organisation_id,
      requiredDocs,
      existingDocument,
      variants: passedVariants,
      variantFailures,
      intake,
      completeness,
      is_refresh,
    })

    const failedKeys = variantFailures.map(f => f.variant)
    await agentRun.complete(
      `Generated ${Object.keys(passedVariants).length}/4 variants.` +
      (failedKeys.length > 0 ? ` Failed: ${failedKeys.join(', ')}.` : ' All variants passed.')
    )

    logger.info('Messaging agent: suggestion written successfully', {
      organisation_id,
      suggestion_id: suggestionId,
      variants_generated: Object.keys(passedVariants).length,
      variants_failed: failedKeys,
    })

    return {
      suggestion_id: suggestionId,
      organisation_id,
      document_type: 'messaging',
      status: 'pending',
      variants_generated: Object.keys(passedVariants).length,
      variants_failed: failedKeys,
    }
  } catch (err) {
    if (!(err instanceof MessagingValidationError)) {
      await agentRun.fail(err instanceof Error ? err.message : String(err))
    }
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
    throw new Error(`Messaging agent: failed to fetch intake responses — ${error.message}`)
  }

  return (data ?? []) as IntakeRow[]
}

// ─── Pre-flight checks ────────────────────────────────────────────────────────

async function runPreflightChecks(
  supabase: SupabaseClient,
  organisation_id: string,
  intake: IntakeRow[]
): Promise<PreflightContext> {
  const missing: string[] = []

  const { data: orgRow } = await supabase
    .from('organisations')
    .select('name')
    .eq('id', organisation_id)
    .single()

  const orgName = orgRow?.name?.trim() ?? ''
  if (!orgName) {
    missing.push('Organisation name is missing. Add it under Settings → Organisation.')
  }

  const { data: operatorRow } = await supabase
    .from('users')
    .select('display_name')
    .eq('organisation_id', organisation_id)
    .eq('role', 'operator')
    .limit(1)
    .single()

  const displayName = operatorRow?.display_name?.trim() ?? ''
  const senderFirstName = displayName.split(/\s+/)[0] ?? ''
  if (!senderFirstName) {
    missing.push(
      'Sender first name is missing. Add a display name for the operator account under Settings → Profile.'
    )
  }

  const companyNameRow = intake.find(r => r.field_key === 'company_name')
  const companyName = companyNameRow?.response_value?.trim() ?? ''
  if (!companyName) {
    missing.push(
      'Company name is missing from the intake questionnaire. Complete the "Company name" field in the intake form.'
    )
  }

  if (missing.length > 0) {
    throw new Error(
      'Messaging agent: cannot generate emails — the following required fields are missing:\n' +
      missing.map((m, i) => `  ${i + 1}. ${m}`).join('\n')
    )
  }

  return {
    org_name: orgName,
    sender_first_name: senderFirstName,
    company_name: companyName,
  }
}

async function fetchRequiredDocuments(
  supabase: SupabaseClient,
  organisation_id: string
): Promise<RequiredDocuments> {
  const { data, error } = await supabase
    .from('strategy_documents')
    .select('id, document_type, version, plain_text, content, status')
    .eq('organisation_id', organisation_id) // explicit isolation filter
    .in('document_type', ['icp', 'positioning', 'tov'])
    .order('created_at', { ascending: false })

  if (error) {
    throw new Error(`Messaging agent: failed to fetch strategy documents — ${error.message}`)
  }

  const docs = (data ?? []) as StrategyDocument[]

  const byType: Partial<Record<string, StrategyDocument>> = {}
  for (const doc of docs) {
    if (!byType[doc.document_type]) {
      byType[doc.document_type] = doc
    }
  }

  const docLabels: Record<string, string> = {
    icp: 'ICP document',
    positioning: 'Positioning document',
    tov: 'Tone of Voice guide',
  }
  const errors: string[] = []

  for (const [type, label] of Object.entries(docLabels)) {
    const doc = byType[type]
    if (!doc) {
      errors.push(
        `${label} has not been generated yet. Run the ${label.split(' ')[0]} agent first.`
      )
    } else if (doc.status !== 'active') {
      errors.push(
        `${label} exists but has status "${doc.status}". ` +
        `Approve it in the dashboard before running the messaging agent.`
      )
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Messaging agent: cannot run — the following documents need attention:\n` +
      errors.map((e, i) => `  ${i + 1}. ${e}`).join('\n')
    )
  }

  return {
    icp:         byType['icp']!,
    positioning: byType['positioning']!,
    tov:         byType['tov']!,
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

  if (error) return null

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
  preflight: PreflightContext
}): string {
  const { intake, requiredDocs, existingDocument, patterns, completeness, preflight } = params

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

  const senderContext =
    `\n\n---\n\n## SENDER CONTEXT\n\n` +
    `Organisation name: ${preflight.org_name}\n` +
    `Sender first name (use this on the sign-off line of every email — never leave it blank): ${preflight.sender_first_name}\n` +
    `Client company name (use for context and the companyName token): ${preflight.company_name}`

  return `You are generating four distinct messaging sequence variants for a founder-led B2B consulting firm.
${completenessNote}

The three strategy documents below are your primary context. They contain everything you need
to write copy that is specific, grounded, and consistent. Do not invent details not present in them.

## INTAKE QUESTIONNAIRE RESPONSES

${intakeSections}${icpBlock}${positioningBlock}${tovBlock}${senderContext}${refreshContext}${patternContext}

---

## FOUR-VARIANT SEQUENCE INSTRUCTION

Generate four distinct email sequence variants: A, B, C, and D.
Each variant is a complete 4-email sequence targeting the same ICP, offer, and positioning.
The primary angle changes across variants. The TOV voice, rules, and offer framing do not change.

Angle assignments — these determine how Email 1 opens:
- Variant A: Pain-led — email 1 opens with the implied cost or consequence of the current situation
- Variant B: Outcome-led — email 1 opens with what their world looks like after the problem is resolved
- Variant C: Peer pattern — email 1 opens with what similar founders at this stage are experiencing
- Variant D: Pattern interrupt — email 1 opens with a direct observation that challenges a common assumption

All four variants must:
- Follow every rule in the system prompt without exception
- Use different subject lines — no subject line is reused across variants
- Use a meaningfully different opening sentence in email 1 (the angle changes the first line after {{first_name}})
- Keep the sequence structure: Email 1 problem/CTA, Email 2 pattern proof, Email 3 insight/meeting ask, Email 4 breakup
- Apply every word count limit, TOV rule, banned structure rule, and sign-off rule from the system prompt

Critical reminders:
- Word counts are hard caps: Email 1 ≤100 words, Emails 2-3 ≤75 words, Email 4 30-50 words
- Count every word. Include the accurate word_count in each email object.
- No I/We openers. One question per message. No service-led language. No em dashes.
- Every email ends with first name only on its own line — no pleasantry before it.

Return ONLY the four-variant JSON below. No subject line libraries. No CTA libraries. No objection responses. No explanation. No markdown fencing.

Return raw JSON with this exact structure:
{
  "variants": {
    "A": { "emails": [/* 4 email objects */] },
    "B": { "emails": [/* 4 email objects */] },
    "C": { "emails": [/* 4 email objects */] },
    "D": { "emails": [/* 4 email objects */] }
  }
}

Each email object must contain exactly these fields:
  sequence_position: integer 1-4
  subject_line: string for emails 1 and 4, null for emails 2 and 3
  subject_char_count: integer, 0 for emails 2 and 3
  body: full email body from {{first_name}} through the sign-off name
  word_count: integer (count body words excluding the first-name line and sign-off name)
  suggestion_reason: per-email notes (deliberate imperfection, unpopulated tokens, pronoun ratio shortfall)`
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

  // Use streaming to keep the TCP connection alive during long generations.
  // Without streaming, routers and macOS drop connections that look idle after ~180s,
  // even though the server is still working. Tokens arrive continuously in stream mode.
  const stream = client.messages.stream({
    model: MESSAGING_MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  })

  const message = await stream.finalMessage()

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

// ─── Parsing ──────────────────────────────────────────────────────────────────

// Parses the four-variant JSON structure returned by Claude.
// Expected: { variants: { A: { emails: [...] }, B: { emails: [...] }, C: {...}, D: {...} } }
function parseVariantsFromClaude(raw: string): Record<string, EmailRecord[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      'Messaging agent: Claude returned invalid JSON for four-variant response. ' + String(err)
    )
  }

  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    'variants' in parsed
  ) {
    const variants = (parsed as Record<string, unknown>).variants
    if (typeof variants === 'object' && variants !== null) {
      const result: Record<string, EmailRecord[]> = {}
      for (const [key, value] of Object.entries(variants as Record<string, unknown>)) {
        if (
          typeof value === 'object' &&
          value !== null &&
          'emails' in value &&
          Array.isArray((value as Record<string, unknown>).emails)
        ) {
          result[key] = (value as Record<string, unknown>).emails as EmailRecord[]
        }
      }
      if (Object.keys(result).length > 0) return result
    }
  }

  throw new Error(
    `Messaging agent: expected { variants: { A: { emails: [...] }, ... } }, got: ${typeof parsed}. ` +
    'Check that the system prompt correctly instructs four-variant JSON output.'
  )
}

// ─── Post-processing ──────────────────────────────────────────────────────────

interface ValidationViolation {
  email: number
  issue: string
}

class MessagingValidationError extends Error {
  constructor(
    public readonly violations: ValidationViolation[],
    public readonly emails: EmailRecord[]
  ) {
    const lines = violations.map(v => `  Email ${v.email}: ${v.issue}`)
    super(`Messaging agent: post-processing validation failed.\n${lines.join('\n')}`)
    this.name = 'MessagingValidationError'
  }
}

// Processes all four variants independently.
// Each variant's emails go through em-dash auto-fix, then the 10-rule validation gate.
// Passing variants are collected. Failing variants are flagged and logged.
async function processAllVariants(
  rawVariants: Record<string, EmailRecord[]>,
  senderFirstName: string,
  organisation_id: string
): Promise<{ passedVariants: Record<string, EmailRecord[]>; variantFailures: VariantFailure[] }> {
  const passedVariants: Record<string, EmailRecord[]> = {}
  const variantFailures: VariantFailure[] = []

  for (const [variantKey, emails] of Object.entries(rawVariants)) {
    if (!Array.isArray(emails) || emails.length !== 4) {
      variantFailures.push({
        variant: variantKey,
        violations: [{
          email: 0,
          issue: `Expected 4 emails, got ${Array.isArray(emails) ? emails.length : 'non-array'}`,
        }],
      })
      continue
    }

    const { emails: fixedEmails, totalReplacements, perEmail } = applyEmDashFixes(emails)
    if (totalReplacements > 0) {
      const detail = Object.entries(perEmail)
        .map(([pos, n]) => `email ${pos} (${n})`)
        .join(', ')
      logger.info(
        `Messaging agent: Variant ${variantKey} — replaced ${totalReplacements} em dash(es) across ${detail}`
      )
    }

    const violations = validateEmails(fixedEmails, senderFirstName)
    if (violations.length > 0) {
      variantFailures.push({ variant: variantKey, violations })
      logger.warn(`Messaging agent: Variant ${variantKey} failed validation`, {
        variantKey,
        violations: violations.map(v => `Email ${v.email}: ${v.issue}`),
      })
      await saveFailedGeneration(fixedEmails, violations, organisation_id, variantKey)
    } else {
      passedVariants[variantKey] = fixedEmails
    }
  }

  return { passedVariants, variantFailures }
}

// Category A: replace em dashes with period or comma based on what follows.
function applyEmDashFixes(emails: EmailRecord[]): {
  emails: EmailRecord[]
  totalReplacements: number
  perEmail: Record<number, number>
} {
  const perEmail: Record<number, number> = {}
  let totalReplacements = 0

  const fixed = emails.map(email => {
    let count = 0
    const fixedBody = email.body.replace(
      /\s*—\s*/g,
      (match: string, offset: number, str: string) => {
        count++
        const firstCharAfter = str.slice(offset + match.length).trimStart()[0] ?? ''
        const isLower =
          firstCharAfter.length > 0 &&
          firstCharAfter === firstCharAfter.toLowerCase() &&
          firstCharAfter !== firstCharAfter.toUpperCase()
        return isLower ? ', ' : '. '
      }
    )
    if (count > 0) {
      perEmail[email.sequence_position] = count
      totalReplacements += count
    }
    return { ...email, body: fixedBody.trim() }
  })

  return { emails: fixed, totalReplacements, perEmail }
}

// Category B: collect all violations across all four emails. Returns empty array if clean.
function validateEmails(
  emails: EmailRecord[],
  senderFirstName: string
): ValidationViolation[] {
  const violations: ValidationViolation[] = []

  for (const email of emails) {
    const pos = email.sequence_position
    const body = email.body
    const nonEmptyLines = body.split('\n').map(l => l.trim()).filter(l => l.length > 0)

    if (body.includes('[FIRST_NAME]')) {
      violations.push({ email: pos, issue: 'contains old [FIRST_NAME] merge tag — must be {{first_name}}' })
    }

    const firstNameIdx = nonEmptyLines.findIndex(l => l === '{{first_name}}')
    const openerLine = firstNameIdx >= 0
      ? (nonEmptyLines[firstNameIdx + 1] ?? '')
      : (nonEmptyLines[0] ?? '')
    if (/^(i|we)\s/i.test(openerLine)) {
      violations.push({
        email: pos,
        issue: `opener starts with "${openerLine.split(' ')[0]}" — I/We openers are banned`,
      })
    }

    const wc = email.word_count
    if (pos === 1 && wc > 100) violations.push({ email: pos, issue: `word count ${wc} exceeds 100-word limit` })
    if (pos === 2 && wc > 75)  violations.push({ email: pos, issue: `word count ${wc} exceeds 75-word limit` })
    if (pos === 3 && wc > 75)  violations.push({ email: pos, issue: `word count ${wc} exceeds 75-word limit` })
    if (pos === 4 && (wc < 30 || wc > 50)) {
      violations.push({ email: pos, issue: `word count ${wc} is outside the 30–50 word range` })
    }

    if ((pos === 2 || pos === 3) && email.subject_line !== null) {
      violations.push({
        email: pos,
        issue: `subject line must be null for threading, got "${email.subject_line}"`,
      })
    }

    if (pos === 4 && email.subject_line !== null && email.subject_line.length > 9) {
      violations.push({
        email: pos,
        issue: `subject line "${email.subject_line}" is ${email.subject_line.length} chars, limit is 9`,
      })
    }

    const lastLine = nonEmptyLines[nonEmptyLines.length - 1] ?? ''
    if (lastLine.toLowerCase() !== senderFirstName.toLowerCase()) {
      violations.push({
        email: pos,
        issue: `missing or incorrect sign-off — last line is "${lastLine}", expected "${senderFirstName}"`,
      })
    }

    const bannedMatch = body.match(/\bAI\b|\bautomated\b|\bbot\b|artificial intelligence/i)
    if (bannedMatch) {
      violations.push({
        email: pos,
        issue: `contains banned word "${bannedMatch[0]}" — must not reference AI, automation, or bots`,
      })
    }
  }

  return violations
}

async function saveFailedGeneration(
  emails: EmailRecord[],
  violations: ValidationViolation[],
  organisation_id: string,
  variantKey?: string
): Promise<void> {
  const { mkdir, writeFile } = await import('fs/promises')
  const { join } = await import('path')

  const dir = join(process.cwd(), 'logs', 'messaging-agent-failures')
  await mkdir(dir, { recursive: true })

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const variantSuffix = variantKey ? `-variant-${variantKey}` : ''
  const filePath = join(dir, `${timestamp}${variantSuffix}.json`)

  await writeFile(
    filePath,
    JSON.stringify(
      { organisation_id, timestamp: new Date().toISOString(), variantKey, violations, emails },
      null,
      2
    ),
    'utf-8'
  )

  logger.info('Messaging agent: failed generation saved to disk', { path: filePath, variantKey })
}

// ─── Write to document_suggestions ───────────────────────────────────────────

// Writes a single row to document_suggestions.
// suggested_value stores: { variants: { A: { emails: [...] }, B: {...}, ... } }
// Matches the full_document pattern used by all document generation agents.
async function writeDocumentSuggestion(
  supabase: SupabaseClient,
  params: {
    organisation_id: string
    requiredDocs: RequiredDocuments
    existingDocument: ExistingMessagingDocument | null
    variants: Record<string, EmailRecord[]>
    variantFailures: VariantFailure[]
    intake: IntakeRow[]
    completeness: number
    is_refresh: boolean
  }
): Promise<string> {
  const {
    organisation_id,
    requiredDocs,
    existingDocument,
    variants,
    variantFailures,
    completeness,
    is_refresh,
  } = params

  const answeredCount = params.intake.filter(
    r => r.response_value && r.response_value.trim().length > 0
  ).length
  const totalCount = params.intake.length

  const variantKeys = Object.keys(variants).sort()
  const failedKeys = variantFailures.map(f => f.variant)

  const refreshNote = is_refresh
    ? ` Refresh — existing v${existingDocument?.version ?? '?'} document used as context.`
    : ' Initial generation.'

  const completenessNote = completeness < 80
    ? ` ⚠️ Intake completeness: ${completeness}% (${answeredCount}/${totalCount} fields).`
    : ` Intake completeness: ${completeness}% (${answeredCount}/${totalCount} fields).`

  const variantNote = ` Variants generated: ${variantKeys.join(', ')}.` +
    (failedKeys.length > 0 ? ` Variants failed post-processing: ${failedKeys.join(', ')}.` : '')

  const sourceVersions =
    ` Source documents: ICP v${requiredDocs.icp.version}, ` +
    `Positioning v${requiredDocs.positioning.version}, ` +
    `TOV v${requiredDocs.tov.version}.`

  const suggestionReason =
    `Four-variant Messaging Playbook generated by messaging-generation-agent using ${MESSAGING_MODEL}.` +
    refreshNote +
    completenessNote +
    variantNote +
    sourceVersions

  // Strip per-email suggestion_reason before storing — it's agent metadata, not document content.
  const variantsForStorage = Object.fromEntries(
    variantKeys.map(key => [
      key,
      { emails: variants[key].map(({ suggestion_reason: _unused, ...email }) => email) },
    ])
  )

  const { data, error } = await supabase
    .from('document_suggestions')
    .insert({
      organisation_id,
      document_id: existingDocument?.id ?? null,
      document_type: 'messaging',
      field_path: 'full_document',
      current_value: existingDocument?.plain_text ?? null,
      suggested_value: JSON.stringify({ variants: variantsForStorage }),
      suggestion_reason: suggestionReason,
      confidence_level: completeness >= 80 ? 'high' : 'low',
      signal_count: 0,
      status: 'pending',
    })
    .select('id')
    .single()

  if (error) {
    throw new Error(`Messaging agent: failed to write document suggestion — ${error.message}`)
  }

  return data.id as string
}
