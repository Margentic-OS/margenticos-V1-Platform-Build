// Reply Draft Agent
// Generates Tier 2 (send-ready) and Tier 3 (starting-point) reply drafts.
// Per ADR-013: claude-sonnet-4-6. Per ADR-018: LLM justified — tone, voice, judgment required.
// Per ADR-019: fitness-driven tier routing — drafter may downgrade Tier 2 → Tier 3.
//
// ISOLATION: organisationId is required. Agent does NOT load org context from the DB.
// Caller provides already-loaded TOV and Positioning documents. Keeps agent stateless.
//
// OUTPUT: Returns a discriminated union (Tier 2 or Tier 3) or null on any failure.
// Does NOT write to reply_drafts — that is the caller's job (Group 4).

import Anthropic from '@anthropic-ai/sdk'
import type { TextBlock } from '@anthropic-ai/sdk/resources/messages'
import type { SupabaseClient } from '@supabase/supabase-js'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { logger } from '@/lib/logger'
import { scrubAITells } from '@/lib/style/customer-facing-style-rules'

const PROMPT_VERSION = '1.0.0'
const MODEL = 'claude-sonnet-4-6'
const TIMEOUT_MS = 30000
const MAX_TOKENS = 2048
const FAQ_USE_THRESHOLD = 0.65  // FAQ must score ≥ this to be treated as authoritative

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FaqMatch {
  faq_id: string
  question_canonical: string
  answer: string
  score: number
}

export interface ReplyDrafterInput {
  organisationId: string
  organisationName: string
  senderFirstName: string          // context for caller; not used in draft body itself
  prospectReplyBody: string        // plain text only — caller strips HTML upstream
  originalOutboundBody: string     // the email this is replying to
  classification: {
    intent: string
    confidence: number
    reasoning: string
  }
  tierHint: 2 | 3                  // Group 4 decides; drafter MAY downgrade to 3
  orgContext: {
    tovDocument: string            // serialised TOV strategy doc
    positioningDocument: string    // serialised Positioning strategy doc
  }
  faqMatches: FaqMatch[]           // from matcher; may be empty
  includeCalendlyHint: boolean     // true → prompt includes soft-CTA toward booking
  signalId: string                 // for agent_runs logging + idempotency check
  prospectId: string | null        // for agent_runs logging
  supabase: SupabaseClient         // for idempotency check + agent_runs write
}

export type ReplyDrafterOutput =
  | {
      tier: 2
      draft_body: string
      faq_ids_used: string[]
      confidence_at_draft: number
      prompt_version: string
    }
  | {
      tier: 3
      draft_body: string
      ambiguity_note: string
      alternative_directions: string[]
      prompt_version: string
      downgraded_from_tier: 2 | null
    }

// ─── Main exported function ────────────────────────────────────────────────────

export async function draftReply(input: ReplyDrafterInput): Promise<ReplyDrafterOutput | null> {
  const startedAt = Date.now()
  const {
    organisationId,
    organisationName,
    prospectReplyBody,
    originalOutboundBody,
    classification,
    tierHint,
    orgContext,
    faqMatches,
    includeCalendlyHint,
    signalId,
    prospectId,
    supabase,
  } = input

  // ── 1. Pre-flight checks ──────────────────────────────────────────────────
  const preflightErrors: string[] = []
  if (!prospectReplyBody.trim()) preflightErrors.push('prospectReplyBody is empty')
  if (!originalOutboundBody.trim()) preflightErrors.push('originalOutboundBody is empty')
  if (!classification.intent.trim()) preflightErrors.push('classification.intent is empty')
  if (!orgContext.tovDocument.trim()) preflightErrors.push('orgContext.tovDocument is empty')
  if (!orgContext.positioningDocument.trim()) preflightErrors.push('orgContext.positioningDocument is empty')

  if (preflightErrors.length > 0) {
    const msg = `reply-draft-agent: pre-flight failed — ${preflightErrors.join('; ')}`
    logger.error(msg, { signal_id: signalId })
    await writeAgentRun(supabase, {
      organisationId,
      signalId,
      prospectId,
      status: 'failed',
      errorMessage: msg,
      durationMs: Date.now() - startedAt,
    })
    return null
  }

  // ── 2. Idempotency check ─────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: existingDraft } = await (supabase as any)
    .from('reply_drafts')
    .select('id')
    .eq('signal_id', signalId)
    .maybeSingle()

  if (existingDraft) {
    const msg = `reply-draft-agent: draft already exists for signal_id ${signalId} — skipping`
    logger.info(msg)
    await writeAgentRun(supabase, {
      organisationId,
      signalId,
      prospectId,
      status: 'skipped_idempotent',
      durationMs: Date.now() - startedAt,
    })
    return null
  }

  // ── 3. Build prompt ────────────────────────────────────────────────────────
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    const msg = 'reply-draft-agent: ANTHROPIC_API_KEY not set'
    logger.error(msg, { signal_id: signalId })
    await writeAgentRun(supabase, {
      organisationId, signalId, prospectId,
      status: 'failed', errorMessage: msg,
      durationMs: Date.now() - startedAt,
    })
    return null
  }

  const systemPrompt = await loadSystemPrompt(organisationName)
  const userMessage = buildUserMessage(input, faqMatches)

  // ── 4. Call Anthropic API ─────────────────────────────────────────────────
  let rawResponse: string
  try {
    const client = new Anthropic({ apiKey })

    // Streaming mode per messaging-generation-agent.ts pattern (ADR-013).
    const stream = client.messages.stream(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      },
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    )

    const message = await stream.finalMessage()
    const textBlock = message.content.find((b): b is TextBlock => b.type === 'text')
    if (!textBlock) {
      throw new Error('No text block in Sonnet response')
    }
    rawResponse = textBlock.text.trim()
  } catch (err) {
    const msg = `reply-draft-agent: API call failed — ${err instanceof Error ? err.message : String(err)}`
    logger.error(msg, { signal_id: signalId })
    await writeAgentRun(supabase, {
      organisationId, signalId, prospectId,
      status: 'failed', errorMessage: msg,
      durationMs: Date.now() - startedAt,
    })
    return null
  }

  // ── 5. Parse response ──────────────────────────────────────────────────────
  // Extract JSON from response — handles markdown fences and leading prose.
  const jsonMatch = rawResponse.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    const msg = 'reply-draft-agent: no JSON object found in Sonnet response'
    logger.error(msg, { signal_id: signalId, raw_preview: rawResponse.slice(0, 200) })
    await writeAgentRun(supabase, {
      organisationId, signalId, prospectId,
      status: 'failed', errorMessage: msg,
      durationMs: Date.now() - startedAt,
    })
    return null
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(jsonMatch[0])
  } catch {
    const msg = 'reply-draft-agent: failed to parse JSON from Sonnet response'
    logger.error(msg, { signal_id: signalId })
    await writeAgentRun(supabase, {
      organisationId, signalId, prospectId,
      status: 'failed', errorMessage: msg,
      durationMs: Date.now() - startedAt,
    })
    return null
  }

  const tier = parsed.tier
  if (tier !== 2 && tier !== 3) {
    const msg = `reply-draft-agent: unexpected tier value "${tier}" in response`
    logger.error(msg, { signal_id: signalId })
    await writeAgentRun(supabase, {
      organisationId, signalId, prospectId,
      status: 'failed', errorMessage: msg,
      durationMs: Date.now() - startedAt,
    })
    return null
  }

  // Tier 3 input hint with Tier 2 model response: reject — Tier 3 routing was deliberate.
  if (tierHint === 3 && tier === 2) {
    const msg = 'reply-draft-agent: model returned tier 2 but tierHint was 3 — treated as malformed'
    logger.warn(msg, { signal_id: signalId })
    await writeAgentRun(supabase, {
      organisationId, signalId, prospectId,
      status: 'failed', errorMessage: msg,
      durationMs: Date.now() - startedAt,
    })
    return null
  }

  // Validate required fields per tier
  const draftBody = parsed.draft_body as string | undefined
  if (!draftBody || typeof draftBody !== 'string') {
    const msg = 'reply-draft-agent: draft_body missing or not a string'
    logger.error(msg, { signal_id: signalId })
    await writeAgentRun(supabase, {
      organisationId, signalId, prospectId,
      status: 'failed', errorMessage: msg,
      durationMs: Date.now() - startedAt,
    })
    return null
  }

  // ── 6. Post-processing ───────────────────────────────────────────────────
  const scrubbed = scrubAITells(draftBody, `reply-draft/${signalId}`)

  // Minimum length check: 20 words
  const wordCount = scrubbed.trim().split(/\s+/).filter(w => w.length > 0).length
  if (wordCount < 20) {
    const msg = `reply-draft-agent: draft_body too short — ${wordCount} words (minimum 20)`
    logger.error(msg, { signal_id: signalId })
    await writeAgentRun(supabase, {
      organisationId, signalId, prospectId,
      status: 'failed', errorMessage: msg,
      durationMs: Date.now() - startedAt,
    })
    return null
  }

  const durationMs = Date.now() - startedAt

  // ── 7. Build output with metadata fields the LLM does not produce ─────────
  let output: ReplyDrafterOutput

  if (tier === 2) {
    const faqIdsUsed = Array.isArray(parsed.faq_ids_used)
      ? (parsed.faq_ids_used as unknown[]).filter((v): v is string => typeof v === 'string')
      : []

    output = {
      tier: 2,
      draft_body: scrubbed,
      faq_ids_used: faqIdsUsed,
      confidence_at_draft: classification.confidence,
      prompt_version: PROMPT_VERSION,
    }
  } else {
    const ambiguityNote = typeof parsed.ambiguity_note === 'string' ? parsed.ambiguity_note : ''
    const altDirs = Array.isArray(parsed.alternative_directions)
      ? (parsed.alternative_directions as unknown[]).filter((v): v is string => typeof v === 'string')
      : []

    const scrubbedAltDirs = altDirs.map(d => scrubAITells(d, `reply-draft/${signalId}/alt-dir`))

    const downgradedFrom = parsed.downgraded_from_tier === 2 ? 2 : null

    output = {
      tier: 3,
      draft_body: scrubbed,
      ambiguity_note: ambiguityNote,
      alternative_directions: scrubbedAltDirs,
      prompt_version: PROMPT_VERSION,
      downgraded_from_tier: downgradedFrom,
    }
  }

  // ── 8. Log success to agent_runs ─────────────────────────────────────────
  const topFaqScore = faqMatches.length > 0 ? faqMatches[0].score : 0
  const isDowngraded = output.tier === 3 && 'downgraded_from_tier' in output && output.downgraded_from_tier !== null

  await writeAgentRun(supabase, {
    organisationId,
    signalId,
    prospectId,
    status: 'completed',
    inputSummary: JSON.stringify({
      signal_id: signalId,
      intent: classification.intent,
      tier_hint: tierHint,
      faq_match_count: faqMatches.length,
      faq_top_score: topFaqScore,
    }),
    outputSummary: JSON.stringify({
      tier: output.tier,
      downgraded: isDowngraded,
      draft_word_count: wordCount,
      prompt_version: PROMPT_VERSION,
    }),
    durationMs,
  })

  // ── 9. Return — caller writes to reply_drafts ─────────────────────────────
  return output
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function loadSystemPrompt(organisationName: string): Promise<string> {
  const promptPath = join(process.cwd(), 'docs', 'prompts', 'reply-draft-agent.md')
  const raw = await readFile(promptPath, 'utf-8')
  return raw.replace('{organisationName}', organisationName)
}

function buildUserMessage(input: ReplyDrafterInput, faqMatches: FaqMatch[]): string {
  const relevantFaqs = faqMatches.filter(m => m.score >= FAQ_USE_THRESHOLD)

  const userInput = {
    tier_hint: input.tierHint,
    include_calendly_hint: input.includeCalendlyHint,
    prospect_reply_body: input.prospectReplyBody,
    original_outbound_body: input.originalOutboundBody,
    classification: {
      intent: input.classification.intent,
      confidence: input.classification.confidence,
      reasoning: input.classification.reasoning,
    },
    faq_matches: relevantFaqs.map(m => ({
      faq_id: m.faq_id,
      question_canonical: m.question_canonical,
      answer: m.answer,
      score: m.score,
    })),
    org_context: {
      tov_document: input.orgContext.tovDocument,
      positioning_document: input.orgContext.positioningDocument,
    },
  }

  return JSON.stringify(userInput, null, 2)
}

interface AgentRunArgs {
  organisationId: string
  signalId: string
  prospectId: string | null
  status: 'completed' | 'failed' | 'skipped_idempotent'
  errorMessage?: string
  inputSummary?: string
  outputSummary?: string
  durationMs: number
}

async function writeAgentRun(supabase: SupabaseClient, args: AgentRunArgs): Promise<void> {
  const {
    organisationId, signalId, status,
    errorMessage, inputSummary, outputSummary, durationMs,
  } = args

  const now = new Date().toISOString()
  const startedAt = new Date(Date.now() - durationMs).toISOString()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from('agent_runs')
    .insert({
      client_id: organisationId,
      agent_name: 'reply-draft-agent',
      status,
      started_at: startedAt,
      completed_at: now,
      duration_ms: durationMs,
      error_message: errorMessage ?? null,
      output_summary: outputSummary
        ? `${inputSummary ? `INPUT: ${inputSummary} ` : ''}OUTPUT: ${outputSummary}`
        : inputSummary ?? null,
    })

  if (error) {
    logger.warn('reply-draft-agent: failed to write agent_runs row', {
      signal_id: signalId,
      error: error.message,
    })
  }
}
