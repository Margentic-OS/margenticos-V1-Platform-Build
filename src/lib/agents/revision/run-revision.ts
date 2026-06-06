// Document revision agent.
//
// Takes an existing active strategy document and a client's free-text note,
// then produces a revised version of the document and a brief change_summary.
//
// MEDIATION MODEL: the agent honors the intent behind the note, not a literal
// execution. Where the request conflicts with outbound rules, the agent
// implements the closest compliant version and relocates content that does not
// fit to a legitimate home (later email, signature suggestion, website note).
// Nothing from the note is ever silently discarded; change_summary explains
// every decision.
//
// GATES: revised output runs the same deterministic gates as initial generation.
// On gate failure: one automatic retry with the failure context injected into
// the prompt. If the second pass also fails: throws RevisionGateError so the
// caller can return 422 with a human-readable message. A raw gate error never
// reaches the client.
//
// Model: claude-sonnet-4-6. See ADR-013 for model assignment rationale.

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Json } from '@/types/database'
import { logger } from '@/lib/logger'
import { startAgentRun } from '@/lib/agents/log-agent-run'
import {
  scrubAITellsDeep,
  assertNoDashes,
  scrubAITells,
} from '@/lib/style/customer-facing-style-rules'
import {
  validateEmails,
  EMAIL_WORD_LIMITS,
  EMAIL_SUBJECT_LIMITS,
  type EmailRecord,
  type ValidationViolation,
} from '@/agents/messaging-generation-agent'

const REVISION_MODEL = 'claude-sonnet-4-6'
const MAX_TOKENS = 8192

// ─── Public error class ───────────────────────────────────────────────────────

export class RevisionGateError extends Error {
  constructor(
    public readonly violations: string[],
    public readonly documentType: string,
  ) {
    super(`Revision gate failed after retry (${documentType}): ${violations.join('; ')}`)
    this.name = 'RevisionGateError'
  }
}

// ─── Public types ─────────────────────────────────────────────────────────────

export interface DocumentRevisionInput {
  organisation_id: string
  document_type: 'icp' | 'positioning' | 'tov' | 'messaging'
  current_content: Json
  revision_note: string
  supabase: SupabaseClient
}

export interface DocumentRevisionResult {
  revised_content: Json
  change_summary: string
}

// ─── Main function ─────────────────────────────────────────────────────────────

export async function runDocumentRevisionAgent(
  input: DocumentRevisionInput,
): Promise<DocumentRevisionResult> {
  const { organisation_id, document_type } = input

  const run = await startAgentRun({
    organisation_id,
    agent_name: 'document-revision',
  })

  try {
    logger.info('revision agent: starting', { organisation_id, document_type })

    const orgContext = await fetchOrgContext(input.supabase, organisation_id)
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

    // First attempt
    let result = await runOnce(anthropic, input, orgContext, null)

    // If the first attempt raised a RevisionGateError, retry once with the
    // failure context injected into the prompt so the model can correct itself.
    if (result instanceof RevisionGateError) {
      logger.warn('revision agent: gate failure on first pass, retrying', {
        organisation_id,
        document_type,
        violations: result.violations,
      })
      result = await runOnce(anthropic, input, orgContext, result.violations)
    }

    // If the retry also failed the gates, propagate to the caller.
    if (result instanceof RevisionGateError) {
      await run.fail(`Gate failure after retry: ${result.violations.join('; ')}`)
      throw result
    }

    const summary = `${document_type.toUpperCase()} revised. ${result.change_summary}`
    await run.complete(summary)

    logger.info('revision agent: complete', {
      organisation_id,
      document_type,
      change_summary_length: result.change_summary.length,
    })

    return result
  } catch (err) {
    if (err instanceof RevisionGateError) {
      // already called run.fail above
      throw err
    }
    const message = err instanceof Error ? err.message : String(err)
    await run.fail(message)
    logger.error('revision agent: unexpected error', {
      organisation_id,
      document_type,
      error: message,
    })
    throw err
  }
}

// ─── Single LLM pass + gates ──────────────────────────────────────────────────

async function runOnce(
  anthropic: Anthropic,
  input: DocumentRevisionInput,
  orgContext: OrgContext,
  failureContext: string[] | null,
): Promise<DocumentRevisionResult | RevisionGateError> {
  const { organisation_id, document_type, current_content, revision_note } = input

  const prompt = buildRevisionPrompt(
    document_type,
    current_content,
    revision_note,
    orgContext,
    failureContext,
  )

  let raw: string
  try {
    const response = await anthropic.messages.create({
      model: REVISION_MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    })
    const block = response.content.find(b => b.type === 'text')
    raw = block?.type === 'text' ? block.text : ''
  } catch (err) {
    throw new Error(
      `Revision agent LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  let parsed: DocumentRevisionResult
  try {
    parsed = parseRevisionResponse(raw)
  } catch (err) {
    throw new Error(
      `Revision agent: could not parse LLM response: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // Gate 1: scrub AI tells from all string values in the revised content.
  const scrubbed = scrubAITellsDeep(parsed.revised_content, `revision/${document_type}`)
  // Scrub the change_summary too.
  const scrubbed_summary = scrubAITells(parsed.change_summary, `revision/${document_type}/change_summary`)

  // Gate 2: assert no dashes remain after scrubbing.
  try {
    assertNoDashes(scrubbed, `revision/${document_type}`)
    assertNoDashes(scrubbed_summary, `revision/${document_type}/change_summary`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn('revision agent: assertNoDashes gate failure', {
      organisation_id,
      document_type,
      error: message,
    })
    return new RevisionGateError([message], document_type)
  }

  // Gate 3 (messaging only): validate email structure and word counts.
  if (document_type === 'messaging') {
    const violations = validateMessagingContent(scrubbed, orgContext.founder_first_name)
    if (violations.length > 0) {
      const messages = violations.map(v => `Email ${v.email}: ${v.issue}`)
      logger.warn('revision agent: messaging validation gate failure', {
        organisation_id,
        violations: messages,
      })
      return new RevisionGateError(messages, document_type)
    }
  }

  return {
    revised_content: scrubbed,
    change_summary: scrubbed_summary,
  }
}

// ─── Messaging content validator ──────────────────────────────────────────────

function validateMessagingContent(
  content: Json,
  senderFirstName: string | null,
): ValidationViolation[] {
  if (!senderFirstName) {
    logger.warn('revision agent: founder_first_name not found, skipping sign-off validation')
  }

  const variants = extractVariantsFromMessaging(content)
  if (!variants) {
    // Content does not match expected structure. This is a hard failure.
    return [{ email: 0, issue: 'messaging content is not in expected variants structure' }]
  }

  const allViolations: ValidationViolation[] = []
  for (const [variantKey, emails] of Object.entries(variants)) {
    const violations = validateEmails(emails, senderFirstName ?? '')
    for (const v of violations) {
      allViolations.push({
        email: v.email,
        issue: `Variant ${variantKey}: ${v.issue}`,
      })
    }
  }
  return allViolations
}

function extractVariantsFromMessaging(
  content: Json,
): Record<string, EmailRecord[]> | null {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null
  const c = content as Record<string, unknown>
  const variants = c['variants'] as Record<string, unknown> | undefined
  if (!variants || typeof variants !== 'object') return null

  const result: Record<string, EmailRecord[]> = {}
  for (const [key, val] of Object.entries(variants)) {
    if (!val || typeof val !== 'object' || Array.isArray(val)) continue
    const v = val as Record<string, unknown>
    if (!Array.isArray(v['emails'])) continue
    result[key] = v['emails'] as EmailRecord[]
  }
  return Object.keys(result).length > 0 ? result : null
}

// ─── Prompt construction ──────────────────────────────────────────────────────

interface OrgContext {
  org_name: string
  intake_summary: string
  founder_first_name: string | null
}

function buildRevisionPrompt(
  document_type: string,
  current_content: Json,
  revision_note: string,
  orgContext: OrgContext,
  failureContext: string[] | null,
): string {
  const failureBlock = failureContext && failureContext.length > 0
    ? `\n## IMPORTANT: Previous Attempt Failed These Rules\n\nThe previous version of your response violated the rules below. Fix ALL of them in this attempt while still honoring the client's note as closely as possible.\n\n${failureContext.map(f => `- ${f}`).join('\n')}\n`
    : ''

  const messagingRules = document_type === 'messaging'
    ? `\n## Outbound Email Rules (Messaging Only)\n\nThese are hard limits enforced by an automated gate. The gate will reject your output if any rule is broken.\n\nEmail 1 body: maximum ${EMAIL_WORD_LIMITS.email1MaxWords} words (count body words, not including the {{first_name}} greeting or the sender first-name sign-off)\nEmail 2 body: maximum ${EMAIL_WORD_LIMITS.email2MaxWords} words\nEmail 3 body: maximum ${EMAIL_WORD_LIMITS.email3MaxWords} words\nEmail 4 body: ${EMAIL_WORD_LIMITS.email4MinWords} to ${EMAIL_WORD_LIMITS.email4MaxWords} words\n\nEmail 2 and 3 subject_line must be null (they thread under Email 1)\nEmail 4 subject_line: maximum ${EMAIL_SUBJECT_LIMITS.email4MaxChars} characters if present\n\nEvery email body must end with the sender's first name on its own line (${orgContext.founder_first_name ?? 'the name already in the document'}), nothing after it\n\nOpening sentence of every email must not start with "I" or "We"\n\nNo em dashes (—), en dashes (–), or double hyphens (--) anywhere\n\nNo merge tags other than {{first_name}}\n\n## Where to Relocate Content That Does Not Fit\n\nIf the client's note asks for more content than Email 1 can hold at ${EMAIL_WORD_LIMITS.email1MaxWords} words:\n- Move the overflow to Email 2 or Email 3 where the word budget allows\n- If the content belongs in a proof point or credentials position: place in Email 4 if it fits within ${EMAIL_WORD_LIMITS.email4MinWords} to ${EMAIL_WORD_LIMITS.email4MaxWords} words, or note it as a "website or signature suggestion" in change_summary\n\nIf the note asks for a credentials paragraph:\n- That belongs in Email 4 (the "one last note" position), not Email 1\n- If it makes Email 4 too long: condense the strongest single credential and place it there\n- Note in change_summary what was condensed and why\n`
    : ''

  return `You are revising a ${document_type.toUpperCase()} strategy document based on a client's note.

## Organisation
${orgContext.org_name}
${orgContext.intake_summary}

## Current Document (${document_type.toUpperCase()})
\`\`\`json
${JSON.stringify(current_content, null, 2)}
\`\`\`

## Client Revision Note
${revision_note}
${failureBlock}
## Your Role: Mediator, Not Transcriptionist

Honor the intent behind the note, not a literal execution. Follow these steps:

1. Identify what the client is actually trying to achieve.
2. Implement the closest version that respects the document's rules and purpose.
3. If any part of the request conflicts with a rule: implement the closest compliant version AND relocate the content that does not fit to a legitimate home.
4. Never silently ignore any part of the request. Every decision must appear in change_summary.

## What "Mediation" Means in Practice

The client is never wrong about their intent. But they may not know the outbound rules. Your job is to get their intent into the document within those rules.

If the note asks you to add something too long: shorten it to its essential version and place it where it fits.
If the note asks you to add a credentials block to Email 1: that belongs in Email 4 or as a website suggestion, not Email 1.
If the note asks you to remove a rule-required element (like the sign-off): explain this in change_summary and preserve the element.

A client request is never silently discarded. If something truly cannot be accommodated anywhere, say so clearly in change_summary.

## Evidence Rule (All Document Types)

Every fact, statistic, quote, or proof point in the revised content must trace to one of three sources: the client's revision note, the current document, or intake data.

Never invent, round, or substitute numbers, retention rates, client counts, revenue figures, or named examples. If the note contains "47 firms", write "47 firms" or omit it — do not write "over 40 firms". If content must be shortened to fit a word limit, shorten what is there. Do not substitute a different fact.

Population nouns that qualify a stat in the note (e.g. "consulting firms", "founder-led firms") are part of that stat and must not be dropped or swapped for a different noun.

If a stat or proof point from the note cannot be included as stated without breaking a rule, either include it verbatim in a shorter form, or omit it entirely and explain the omission in change_summary.

## Style Rules (All Document Types)

Em dashes (—), en dashes (–), and double hyphens (--) are forbidden. Replace with a period and a new sentence, a comma, or restructure the sentence.

Forbidden phrases: "delve into", "navigate the complexities of", "leverage" as a verb, "seamless", "robust", "at the end of the day", "that said", "furthermore", "moreover", "additionally", "it's worth noting that".
${messagingRules}
## What to Preserve

Preserve the EXACT same JSON structure and field names.
Change only what the note addresses, directly or by implication.
Do not remove, reorder, or rename fields the note does not mention.

## change_summary Format

Write 2 to 5 sentences covering:
- What was honored and how
- What was relocated, why, and exactly where it went
- What (if anything) could not be accommodated, and why not

Use plain, direct language. No em dashes. No AI filler phrases.

## Output Format

Return ONLY valid JSON with no surrounding text and no code fences:
{
  "revised_content": { ...the complete revised document, same structure as the current document... },
  "change_summary": "Plain English summary of what changed and why."
}`
}

// ─── Response parsing ─────────────────────────────────────────────────────────

function parseRevisionResponse(raw: string): DocumentRevisionResult {
  let text = raw.trim()
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) {
    text = fenceMatch[1].trim()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    const jsonMatch = text.match(/(\{[\s\S]*\})/)
    if (!jsonMatch) {
      throw new Error(`could not parse response as JSON. Raw: ${raw.slice(0, 200)}`)
    }
    try {
      parsed = JSON.parse(jsonMatch[1])
    } catch {
      throw new Error(`JSON parse failed. Raw: ${raw.slice(0, 200)}`)
    }
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('revised_content' in parsed) ||
    !('change_summary' in parsed) ||
    typeof (parsed as Record<string, unknown>).change_summary !== 'string'
  ) {
    throw new Error(`response missing required fields. Raw: ${raw.slice(0, 200)}`)
  }

  const p = parsed as { revised_content: Json; change_summary: string }
  return {
    revised_content: p.revised_content,
    change_summary: p.change_summary.trim(),
  }
}

// ─── Data fetching ────────────────────────────────────────────────────────────

async function fetchOrgContext(
  supabase: SupabaseClient,
  organisation_id: string,
): Promise<OrgContext> {
  const [orgResult, intakeResult] = await Promise.all([
    supabase
      .from('organisations')
      .select('name, founder_first_name')
      .eq('id', organisation_id)
      .single(),
    supabase
      .from('intake_responses')
      .select('field_label, response_value, section')
      .eq('organisation_id', organisation_id)
      .eq('is_critical', true)
      .not('response_value', 'is', null)
      .order('section')
      .limit(12),
  ])

  const org_name = orgResult.data?.name ?? 'Unknown Organisation'
  const founder_first_name = orgResult.data?.founder_first_name ?? null

  const intakeLines = (intakeResult.data ?? [])
    .filter(r => r.response_value && r.response_value.trim())
    .map(r => `${r.field_label}: ${r.response_value}`)
    .join('\n')

  return { org_name, intake_summary: intakeLines, founder_first_name }
}
