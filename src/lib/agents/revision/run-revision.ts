// Document revision agent.
//
// Takes an existing active strategy document and a client's free-text note,
// then produces a revised version of the document and a brief change_summary
// describing what changed. This is a targeted edit, not a full regeneration:
// the model receives the current content as JSON and modifies only what the
// note addresses, preserving everything else.
//
// Model: claude-sonnet-4-6 — targeted revision, not full synthesis.
// See ADR-013 for model assignment rationale.
//
// The agent returns revised content + change_summary directly to its caller.
// It does NOT write to document_suggestions or strategy_documents — that
// responsibility belongs to the caller (the revise endpoint), which calls
// promote_strategy_doc_version via RPC.

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Json } from '@/types/database'
import { logger } from '@/lib/logger'

const REVISION_MODEL = 'claude-sonnet-4-6'
const MAX_TOKENS = 8192

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
  const { organisation_id, document_type, current_content, revision_note, supabase } = input

  logger.info('revision agent: starting', { organisation_id, document_type })

  const orgContext = await fetchOrgContext(supabase, organisation_id)
  const prompt = buildRevisionPrompt(document_type, current_content, revision_note, orgContext)

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

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
    logger.error('revision agent: LLM call failed', {
      organisation_id,
      document_type,
      error: err instanceof Error ? err.message : String(err),
    })
    throw new Error(`Revision agent LLM call failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Parse the JSON response. Try once to extract from a code fence if needed.
  const result = parseRevisionResponse(raw)

  logger.info('revision agent: complete', {
    organisation_id,
    document_type,
    change_summary_length: result.change_summary.length,
  })

  return result
}

// ─── Prompt construction ──────────────────────────────────────────────────────

interface OrgContext {
  org_name: string
  intake_summary: string
}

function buildRevisionPrompt(
  document_type: string,
  current_content: Json,
  revision_note: string,
  orgContext: OrgContext,
): string {
  return `You are revising a ${document_type.toUpperCase()} strategy document based on explicit client feedback.

## Organisation
${orgContext.org_name}
${orgContext.intake_summary}

## Current Document (${document_type.toUpperCase()})
\`\`\`json
${JSON.stringify(current_content, null, 2)}
\`\`\`

## Client Revision Note
${revision_note}

## Your Task
1. Revise the document to address the client's note precisely.
2. Preserve the EXACT same JSON structure and every field the note does not mention.
3. Change only what the note asks — no unprompted additions, removals, or reformatting.
4. Write a change_summary of 1–3 sentences describing what changed and why.

Return ONLY valid JSON in this exact shape (no surrounding text, no code fences):
{
  "revised_content": { ...same structure as the current document... },
  "change_summary": "Brief description of what changed."
}`
}

// ─── Response parsing ─────────────────────────────────────────────────────────

function parseRevisionResponse(raw: string): DocumentRevisionResult {
  // Strip code fences if the model wrapped the response.
  let text = raw.trim()
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) {
    text = fenceMatch[1].trim()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Second attempt: find the outermost { } block.
    const jsonMatch = text.match(/(\{[\s\S]*\})/)
    if (!jsonMatch) {
      throw new Error(`Revision agent: could not parse LLM response as JSON. Raw: ${raw.slice(0, 200)}`)
    }
    try {
      parsed = JSON.parse(jsonMatch[1])
    } catch {
      throw new Error(`Revision agent: JSON parse failed. Raw: ${raw.slice(0, 200)}`)
    }
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('revised_content' in parsed) ||
    !('change_summary' in parsed) ||
    typeof (parsed as Record<string, unknown>).change_summary !== 'string'
  ) {
    throw new Error(`Revision agent: response missing required fields. Raw: ${raw.slice(0, 200)}`)
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
      .select('name')
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

  const intakeLines = (intakeResult.data ?? [])
    .filter(r => r.response_value && r.response_value.trim())
    .map(r => `${r.field_label}: ${r.response_value}`)
    .join('\n')

  return { org_name, intake_summary: intakeLines }
}
