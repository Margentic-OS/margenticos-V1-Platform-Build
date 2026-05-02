// FAQ Extraction Agent
// Extracts FAQ candidates from sent Tier 3 reply bodies.
// Per ADR-013: claude-haiku-4-5-20251001 — structured extraction, cost-sensitive (runs on every Tier 3 send).
// Per ADR-018: LLM justified — extracting Q&A pairs from unstructured prose requires judgment.
//   Deterministic gate (filler-detection.ts) runs first and skips obvious non-extractions cheaply.
//
// ISOLATION: organisationId is required. Agent is stateless — all state via explicit parameters.
//
// OUTPUT: Returns FaqExtractionResult[] or [] on any failure / skip.
// Does NOT write to faq_extractions — that is the caller's job (Group 4).
//
// DB COLUMN NOTE: captured_answer in FaqExtractionResult maps to suggested_answer in faq_extractions.
// The caller (Group 4) maps captured_answer → suggested_answer when inserting.

import Anthropic from '@anthropic-ai/sdk'
import type { TextBlock } from '@anthropic-ai/sdk/resources/messages'
import type { SupabaseClient } from '@supabase/supabase-js'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { logger } from '@/lib/logger'
import { scrubAITells } from '@/lib/style/customer-facing-style-rules'
import { shouldSkipExtraction } from '@/lib/faq/filler-detection'
import { detectPotentialNames } from '@/lib/faq/name-detection'
import { findFaqMatches } from '@/lib/faq/matcher'

const PROMPT_VERSION = '1.0.1'
const MODEL = 'claude-haiku-4-5-20251001'
const TIMEOUT_MS = 15000
const MAX_TOKENS = 1024
const SIMILARITY_FLAG_THRESHOLD = 0.45  // similar_faq_id / pending_extraction_id set if top match >= this

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FaqExtractionInput {
  organisationId: string
  organisationName: string          // for prompt context
  replyDraftId: string
  prospectQuestionContext: string   // the prospect's full reply text
  originalOutboundBody: string      // the email the prospect was replying to
  operatorAnswer: string            // the final_sent_body
  aiDraftBody: string               // for unedited-draft skip check
  orgPositioningDocument: string    // for niche-language context in prompt
  supabase: SupabaseClient
}

export interface FaqExtractionResult {
  extracted_question: string
  captured_answer: string           // maps to suggested_answer column in faq_extractions
  similar_faq_id: string | null     // null if no approved FAQ match >= SIMILARITY_FLAG_THRESHOLD
  similar_pending_extraction_id: string | null  // null if no pending match >= threshold
  similarity_score: number | null   // top score across both sources; null if no match
  potential_names_flagged: string[] // from name-detection; surfaced for curation review
  prompt_version: string
}

// ─── Main exported function ────────────────────────────────────────────────────

export async function extractFaq(input: FaqExtractionInput): Promise<FaqExtractionResult[]> {
  const startedAt = Date.now()
  const {
    organisationId,
    organisationName,
    replyDraftId,
    prospectQuestionContext,
    originalOutboundBody,
    operatorAnswer,
    aiDraftBody,
    orgPositioningDocument,
    supabase,
  } = input

  // ── 1. Pre-flight checks ──────────────────────────────────────────────────
  const preflightErrors: string[] = []
  if (!organisationId.trim()) preflightErrors.push('organisationId is empty')
  if (!replyDraftId.trim()) preflightErrors.push('replyDraftId is empty')
  if (!prospectQuestionContext.trim()) preflightErrors.push('prospectQuestionContext is empty')
  if (!operatorAnswer.trim()) preflightErrors.push('operatorAnswer is empty')

  // Validate UUID format for organisationId
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (organisationId.trim() && !UUID_RE.test(organisationId)) {
    preflightErrors.push('organisationId is not a valid UUID')
  }

  if (preflightErrors.length > 0) {
    const msg = `faq-extraction-agent: pre-flight failed — ${preflightErrors.join('; ')}`
    logger.error(msg, { reply_draft_id: replyDraftId })
    await writeAgentRun(supabase, {
      organisationId: organisationId || 'unknown',
      replyDraftId,
      status: 'failed',
      errorMessage: msg,
      durationMs: Date.now() - startedAt,
    })
    return []
  }

  // ── 2. Idempotency check ─────────────────────────────────────────────────
  // Prevents double-extraction if the wiring retries (Group 4).
  // Searches by reply_draft_id in the output_summary text field.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: existingRun } = await (supabase as any)
    .from('agent_runs')
    .select('id')
    .eq('agent_name', 'faq-extraction-agent')
    .eq('status', 'completed')
    .like('output_summary', `%${replyDraftId}%`)
    .maybeSingle()

  if (existingRun) {
    logger.info(`faq-extraction-agent: already ran for reply_draft_id ${replyDraftId} — skipping`)
    await writeAgentRun(supabase, {
      organisationId,
      replyDraftId,
      status: 'skipped_idempotent',
      durationMs: Date.now() - startedAt,
    })
    return []
  }

  // ── 3. Deterministic gate ─────────────────────────────────────────────────
  const gateResult = shouldSkipExtraction({
    prospectQuestion: prospectQuestionContext,
    operatorAnswer,
    aiDraftBody,
  })

  if (gateResult.skip) {
    logger.info(`faq-extraction-agent: gate skipped — ${gateResult.reason}`, { reply_draft_id: replyDraftId })
    await writeAgentRun(supabase, {
      organisationId,
      replyDraftId,
      status: 'skipped',
      outputSummary: JSON.stringify({ skip_reason: gateResult.reason, prompt_version: PROMPT_VERSION }),
      durationMs: Date.now() - startedAt,
    })
    return []
  }

  // ── 4. Build prompt ────────────────────────────────────────────────────────
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    const msg = 'faq-extraction-agent: ANTHROPIC_API_KEY not set'
    logger.error(msg, { reply_draft_id: replyDraftId })
    await writeAgentRun(supabase, {
      organisationId, replyDraftId,
      status: 'failed', errorMessage: msg,
      durationMs: Date.now() - startedAt,
    })
    return []
  }

  const systemPrompt = await loadSystemPrompt(organisationName)
  const userMessage = buildUserMessage({
    prospectQuestionContext,
    originalOutboundBody,
    operatorAnswer,
    orgPositioningDocument,
  })

  // ── 5. Call Anthropic API ─────────────────────────────────────────────────
  // Streaming mode matches reply-draft-agent.ts pattern (ADR-013).
  let rawResponse: string
  try {
    const client = new Anthropic({ apiKey })

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
      throw new Error('No text block in Haiku response')
    }
    rawResponse = textBlock.text.trim()
  } catch (err) {
    const msg = `faq-extraction-agent: API call failed — ${err instanceof Error ? err.message : String(err)}`
    logger.error(msg, { reply_draft_id: replyDraftId })
    await writeAgentRun(supabase, {
      organisationId, replyDraftId,
      status: 'failed', errorMessage: msg,
      durationMs: Date.now() - startedAt,
    })
    return []
  }

  // ── 6. Parse response ──────────────────────────────────────────────────────
  // Extract JSON from response — handles markdown fences and leading prose.
  const jsonMatch = rawResponse.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    const msg = 'faq-extraction-agent: no JSON object found in Haiku response'
    logger.error(msg, { reply_draft_id: replyDraftId, raw_preview: rawResponse.slice(0, 200) })
    await writeAgentRun(supabase, {
      organisationId, replyDraftId,
      status: 'failed', errorMessage: msg,
      durationMs: Date.now() - startedAt,
    })
    return []
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(jsonMatch[0])
  } catch {
    const msg = 'faq-extraction-agent: failed to parse JSON from Haiku response'
    logger.error(msg, { reply_draft_id: replyDraftId })
    await writeAgentRun(supabase, {
      organisationId, replyDraftId,
      status: 'failed', errorMessage: msg,
      durationMs: Date.now() - startedAt,
    })
    return []
  }

  if (!Array.isArray(parsed.extractions)) {
    const msg = 'faq-extraction-agent: response missing "extractions" array'
    logger.error(msg, { reply_draft_id: replyDraftId })
    await writeAgentRun(supabase, {
      organisationId, replyDraftId,
      status: 'failed', errorMessage: msg,
      durationMs: Date.now() - startedAt,
    })
    return []
  }

  // Empty array is a valid outcome — agent decided no extraction was warranted.
  if (parsed.extractions.length === 0) {
    await writeAgentRun(supabase, {
      organisationId, replyDraftId,
      status: 'completed',
      inputSummary: buildInputSummary(input),
      outputSummary: JSON.stringify({ extraction_count: 0, prompt_version: PROMPT_VERSION }),
      durationMs: Date.now() - startedAt,
    })
    return []
  }

  // Validate each extraction shape
  const rawExtractions = parsed.extractions as unknown[]
  const validExtractions: Array<{ extracted_question: string; captured_answer: string }> = []

  for (const item of rawExtractions) {
    if (
      typeof item === 'object' &&
      item !== null &&
      typeof (item as Record<string, unknown>).extracted_question === 'string' &&
      typeof (item as Record<string, unknown>).captured_answer === 'string'
    ) {
      validExtractions.push(item as { extracted_question: string; captured_answer: string })
    } else {
      logger.warn('faq-extraction-agent: skipping malformed extraction entry', {
        reply_draft_id: replyDraftId,
        item: JSON.stringify(item),
      })
    }
  }

  if (validExtractions.length === 0) {
    const msg = 'faq-extraction-agent: no valid extraction entries after validation'
    logger.error(msg, { reply_draft_id: replyDraftId })
    await writeAgentRun(supabase, {
      organisationId, replyDraftId,
      status: 'failed', errorMessage: msg,
      durationMs: Date.now() - startedAt,
    })
    return []
  }

  // ── 7. Post-processing ────────────────────────────────────────────────────
  const results: FaqExtractionResult[] = []

  for (const extraction of validExtractions) {
    // a. Scrub AI tells from captured_answer
    const scrubbedAnswer = scrubAITells(extraction.captured_answer, `faq-extraction/${replyDraftId}`)

    // b. Detect potential personal names for curation review
    const potentialNamesFromAnswer = detectPotentialNames(scrubbedAnswer)
    const potentialNamesFromQuestion = detectPotentialNames(extraction.extracted_question)
    const allNameFlags = Array.from(new Set([...potentialNamesFromAnswer, ...potentialNamesFromQuestion]))

    // c. Similarity check against approved FAQs + pending extractions
    const matches = await findFaqMatches({
      organisationId,
      questionText: extraction.extracted_question,
      supabase,
      limit: 1,
      includePendingExtractions: true,
    })

    let similarFaqId: string | null = null
    let similarPendingExtractionId: string | null = null
    let similarityScore: number | null = null

    if (matches.length > 0 && matches[0].score >= SIMILARITY_FLAG_THRESHOLD) {
      const top = matches[0]
      similarityScore = top.score

      if (top.source === 'approved_faq') {
        // ── 8. Multi-tenant defensive check ─────────────────────────────────
        // faq_id must belong to this organisation — the matcher already filtered
        // by organisationId, but we assert defensively per ADR-003.
        if (top.faq_id !== null) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data: faqRow } = await (supabase as any)
            .from('faqs')
            .select('organisation_id')
            .eq('id', top.faq_id)
            .maybeSingle()

          if (!faqRow || faqRow.organisation_id !== organisationId) {
            const msg = `faq-extraction-agent: CRITICAL — faq_id ${top.faq_id} does not belong to org ${organisationId}`
            logger.error(msg, { reply_draft_id: replyDraftId })
            await writeAgentRun(supabase, {
              organisationId, replyDraftId,
              status: 'failed', errorMessage: msg,
              durationMs: Date.now() - startedAt,
            })
            return []
          }

          similarFaqId = top.faq_id
        }
      } else {
        // source === 'pending_extraction'
        if (top.pending_extraction_id !== null) {
          // Defensive check: pending_extraction must belong to this organisation
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data: extractionRow } = await (supabase as any)
            .from('faq_extractions')
            .select('organisation_id')
            .eq('id', top.pending_extraction_id)
            .maybeSingle()

          if (!extractionRow || extractionRow.organisation_id !== organisationId) {
            const msg = `faq-extraction-agent: CRITICAL — pending_extraction_id ${top.pending_extraction_id} does not belong to org ${organisationId}`
            logger.error(msg, { reply_draft_id: replyDraftId })
            await writeAgentRun(supabase, {
              organisationId, replyDraftId,
              status: 'failed', errorMessage: msg,
              durationMs: Date.now() - startedAt,
            })
            return []
          }

          similarPendingExtractionId = top.pending_extraction_id
        }
      }
    }

    // ── 9. Add prompt_version and accumulate ────────────────────────────────
    results.push({
      extracted_question: extraction.extracted_question,
      captured_answer: scrubbedAnswer,
      similar_faq_id: similarFaqId,
      similar_pending_extraction_id: similarPendingExtractionId,
      similarity_score: similarityScore,
      potential_names_flagged: allNameFlags,
      prompt_version: PROMPT_VERSION,
    })
  }

  // ── 10. Log success ────────────────────────────────────────────────────────
  const anyNamFlagged = results.some(r => r.potential_names_flagged.length > 0)
  const anySimilarMatches = results.some(
    r => r.similar_faq_id !== null || r.similar_pending_extraction_id !== null,
  )

  await writeAgentRun(supabase, {
    organisationId,
    replyDraftId,
    status: 'completed',
    inputSummary: buildInputSummary(input),
    outputSummary: JSON.stringify({
      extraction_count: results.length,
      prompt_version: PROMPT_VERSION,
      any_names_flagged: anyNamFlagged,
      any_similar_matches: anySimilarMatches,
    }),
    durationMs: Date.now() - startedAt,
  })

  // ── 11. Return — caller (Group 4) writes to faq_extractions ───────────────
  return results
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function loadSystemPrompt(organisationName: string): Promise<string> {
  const promptPath = join(process.cwd(), 'docs', 'prompts', 'faq-extraction-agent.md')
  const raw = await readFile(promptPath, 'utf-8')
  return raw.replace('{organisationName}', organisationName)
}

function buildUserMessage({
  prospectQuestionContext,
  originalOutboundBody,
  operatorAnswer,
  orgPositioningDocument,
}: {
  prospectQuestionContext: string
  originalOutboundBody: string
  operatorAnswer: string
  orgPositioningDocument: string
}): string {
  return JSON.stringify(
    {
      prospect_question_context: prospectQuestionContext,
      original_outbound_body: originalOutboundBody,
      operator_answer: operatorAnswer,
      positioning_document_context: orgPositioningDocument,
    },
    null,
    2,
  )
}

function buildInputSummary(input: FaqExtractionInput): string {
  return JSON.stringify({
    reply_draft_id: input.replyDraftId,
    organisation_id: input.organisationId,
    has_ai_draft: Boolean(input.aiDraftBody.trim()),
    operator_answer_length: input.operatorAnswer.length,
  })
}

interface AgentRunArgs {
  organisationId: string
  replyDraftId: string
  status: string
  errorMessage?: string
  inputSummary?: string
  outputSummary?: string
  durationMs: number
}

async function writeAgentRun(supabase: SupabaseClient, args: AgentRunArgs): Promise<void> {
  const { organisationId, replyDraftId, status, errorMessage, inputSummary, outputSummary, durationMs } = args

  const now = new Date().toISOString()
  const startedAt = new Date(Date.now() - durationMs).toISOString()

  // Combined input+output in output_summary — same pattern as reply-draft-agent.
  // reply_draft_id is always present so idempotency queries can find it via LIKE.
  const combinedSummary = [
    inputSummary ? `INPUT: ${inputSummary}` : null,
    outputSummary ? `OUTPUT: ${outputSummary}` : null,
    // Always embed reply_draft_id even when there's no other summary
    !inputSummary && !outputSummary ? `reply_draft_id:${replyDraftId}` : null,
  ]
    .filter(Boolean)
    .join(' ')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from('agent_runs')
    .insert({
      client_id: organisationId,
      agent_name: 'faq-extraction-agent',
      status,
      started_at: startedAt,
      completed_at: now,
      duration_ms: durationMs,
      error_message: errorMessage ?? null,
      output_summary: combinedSummary || null,
    })

  if (error) {
    logger.warn('faq-extraction-agent: failed to write agent_runs row', {
      reply_draft_id: replyDraftId,
      error: error.message,
    })
  }
}
