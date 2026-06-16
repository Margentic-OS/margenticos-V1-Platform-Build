// FAQ Seed Agent
// Generates baseline FAQ question/answer pairs from organisation materials.
// Per ADR-013: claude-opus-4-6 (document generation tier, highest quality).
// Per ADR-018: LLM justified — synthesis from unstructured materials to structured Q&A.
//
// ISOLATION: organisationId is required. Agent is stateless — all state via explicit parameters.
// Reads only target org's intake, ICP, positioning, TOV, messaging, and website content.
// Writes only to faq_extractions table with source='seed_generated', scoped to target organisation.
// Write-side trigger (validate_faq_extractions_org_consistency) protects against cross-org writes.

import Anthropic from '@anthropic-ai/sdk'
import type { TextBlock } from '@anthropic-ai/sdk/resources/messages'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

const PROMPT_VERSION = '1.0.0'
const MODEL = 'claude-opus-4-6'
const TIMEOUT_MS = 60000
const MAX_TOKENS = 4000

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FaqSeedInput {
  organisationId: string
  organisationName: string
  intakeAnswers: Record<string, unknown>
  icpDocument: string
  positioningDocument: string
  tovDocument: string
  messagingDocument: string
  websiteContent?: string
  supabase: SupabaseClient
}

export interface FaqSeedResult {
  extracted_question: string
  suggested_answer: string
  source_material: string
  prompt_version: string
}

// ─── Main exported function ────────────────────────────────────────────────────

export async function generateFaqSeedCandidates(input: FaqSeedInput): Promise<FaqSeedResult[]> {
  const startedAt = Date.now()
  const {
    organisationId,
    organisationName,
    intakeAnswers,
    icpDocument,
    positioningDocument,
    tovDocument,
    messagingDocument,
    websiteContent,
    supabase,
  } = input

  // ── 1. Pre-flight checks ────────────────────────────────────────────────────
  const preflightErrors: string[] = []
  if (!organisationId.trim()) preflightErrors.push('organisationId is empty')
  if (!organisationName.trim()) preflightErrors.push('organisationName is empty')
  if (!icpDocument.trim()) preflightErrors.push('icpDocument is empty')
  if (!positioningDocument.trim()) preflightErrors.push('positioningDocument is empty')
  if (!tovDocument.trim()) preflightErrors.push('tovDocument is empty')
  if (!messagingDocument.trim()) preflightErrors.push('messagingDocument is empty')

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (organisationId.trim() && !UUID_RE.test(organisationId)) {
    preflightErrors.push('organisationId is not a valid UUID')
  }

  if (preflightErrors.length > 0) {
    const msg = `faq-seed-agent: pre-flight failed — ${preflightErrors.join('; ')}`
    logger.error(msg, { organisation_id: organisationId })
    await writeAgentRun(supabase, {
      organisationId: organisationId || 'unknown',
      status: 'failed',
      errorMessage: msg,
      durationMs: Date.now() - startedAt,
    })
    return []
  }

  // ── 2. Build prompt ────────────────────────────────────────────────────────
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    const msg = 'faq-seed-agent: ANTHROPIC_API_KEY not set'
    logger.error(msg, { organisation_id: organisationId })
    await writeAgentRun(supabase, {
      organisationId,
      status: 'failed',
      errorMessage: msg,
      durationMs: Date.now() - startedAt,
    })
    return []
  }

  const systemPrompt = buildSystemPrompt(organisationName)
  const userMessage = buildUserMessage({
    intakeAnswers,
    icpDocument,
    positioningDocument,
    tovDocument,
    messagingDocument,
    websiteContent,
  })

  // ── 3. Call Anthropic API ──────────────────────────────────────────────────
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
      throw new Error('No text block in Opus response')
    }
    rawResponse = textBlock.text.trim()
  } catch (err) {
    const msg = `faq-seed-agent: API call failed — ${err instanceof Error ? err.message : String(err)}`
    logger.error(msg, { organisation_id: organisationId })
    await writeAgentRun(supabase, {
      organisationId,
      status: 'failed',
      errorMessage: msg,
      durationMs: Date.now() - startedAt,
    })
    return []
  }

  // ── 4. Parse response ──────────────────────────────────────────────────────
  const jsonMatch = rawResponse.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    const msg = 'faq-seed-agent: no JSON object found in Opus response'
    logger.error(msg, { organisation_id: organisationId, raw_preview: rawResponse.slice(0, 200) })
    await writeAgentRun(supabase, {
      organisationId,
      status: 'failed',
      errorMessage: msg,
      durationMs: Date.now() - startedAt,
    })
    return []
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(jsonMatch[0])
  } catch {
    const msg = 'faq-seed-agent: failed to parse JSON from Opus response'
    logger.error(msg, { organisation_id: organisationId })
    await writeAgentRun(supabase, {
      organisationId,
      status: 'failed',
      errorMessage: msg,
      durationMs: Date.now() - startedAt,
    })
    return []
  }

  if (!Array.isArray(parsed.faqs)) {
    const msg = 'faq-seed-agent: response missing "faqs" array'
    logger.error(msg, { organisation_id: organisationId })
    await writeAgentRun(supabase, {
      organisationId,
      status: 'failed',
      errorMessage: msg,
      durationMs: Date.now() - startedAt,
    })
    return []
  }

  // Empty array is valid — no seed FAQs generated
  if (parsed.faqs.length === 0) {
    await writeAgentRun(supabase, {
      organisationId,
      status: 'completed',
      outputSummary: JSON.stringify({ faq_count: 0, prompt_version: PROMPT_VERSION }),
      durationMs: Date.now() - startedAt,
    })
    return []
  }

  // ── 5. Validate and accumulate results ──────────────────────────────────────
  const rawFaqs = parsed.faqs as unknown[]
  const results: FaqSeedResult[] = []

  for (const item of rawFaqs) {
    if (
      typeof item === 'object' &&
      item !== null &&
      typeof (item as Record<string, unknown>).question === 'string' &&
      typeof (item as Record<string, unknown>).answer === 'string' &&
      typeof (item as Record<string, unknown>).source === 'string'
    ) {
      const faq = item as { question: string; answer: string; source: string }
      if (faq.question.trim() && faq.answer.trim()) {
        results.push({
          extracted_question: faq.question.trim(),
          suggested_answer: faq.answer.trim(),
          source_material: faq.source,
          prompt_version: PROMPT_VERSION,
        })
      }
    } else {
      logger.warn('faq-seed-agent: skipping malformed FAQ entry', {
        organisation_id: organisationId,
        item: JSON.stringify(item),
      })
    }
  }

  if (results.length === 0) {
    const msg = 'faq-seed-agent: no valid FAQ entries after validation'
    logger.error(msg, { organisation_id: organisationId })
    await writeAgentRun(supabase, {
      organisationId,
      status: 'failed',
      errorMessage: msg,
      durationMs: Date.now() - startedAt,
    })
    return []
  }

  // ── 6. Log success ─────────────────────────────────────────────────────────
  await writeAgentRun(supabase, {
    organisationId,
    status: 'completed',
    outputSummary: JSON.stringify({
      faq_count: results.length,
      prompt_version: PROMPT_VERSION,
      source_distribution: results.reduce(
        (acc, r) => {
          acc[r.source_material] = (acc[r.source_material] || 0) + 1
          return acc
        },
        {} as Record<string, number>,
      ),
    }),
    durationMs: Date.now() - startedAt,
  })

  return results
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildSystemPrompt(organisationName: string): string {
  return `You are an expert FAQ generator for ${organisationName}. Your task is to generate
baseline FAQ question/answer pairs from the organisation's strategy documents and materials.

Generate FAQs that:
1. Capture common questions prospects and clients might ask
2. Are grounded in the organisation's materials (ICP, positioning, tone of voice, messaging)
3. Use language consistent with the organisation's tone and positioning
4. Are concise and directly answered (one FAQ = one Q/A pair)
5. Avoid generic advice — answers must be specific to this organisation

Output ONLY valid JSON with this structure:
{
  "faqs": [
    {
      "question": "Question text here?",
      "answer": "Answer text here.",
      "source": "source_document_name (e.g. 'icp', 'positioning', 'messaging')"
    }
  ]
}

Generate 5–15 baseline FAQs. If materials are thin on a topic, omit FAQs on that topic rather than generating generic content.`
}

function buildUserMessage(input: {
  intakeAnswers: Record<string, unknown>
  icpDocument: string
  positioningDocument: string
  tovDocument: string
  messagingDocument: string
  websiteContent?: string
}): string {
  return JSON.stringify(
    {
      intake_answers: input.intakeAnswers,
      icp_document: input.icpDocument,
      positioning_document: input.positioningDocument,
      tov_document: input.tovDocument,
      messaging_document: input.messagingDocument,
      website_content: input.websiteContent || '(not provided)',
    },
    null,
    2,
  )
}

interface AgentRunArgs {
  organisationId: string
  status: string
  errorMessage?: string
  outputSummary?: string
  durationMs: number
}

async function writeAgentRun(supabase: SupabaseClient, args: AgentRunArgs): Promise<void> {
  const { organisationId, status, errorMessage, outputSummary, durationMs } = args

  const now = new Date().toISOString()
  const startedAt = new Date(Date.now() - durationMs).toISOString()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from('agent_runs')
    .insert({
      organisation_id: organisationId,
      agent_name: 'faq-seed-agent',
      status,
      started_at: startedAt,
      completed_at: now,
      duration_ms: durationMs,
      error_message: errorMessage ?? null,
      output_summary: outputSummary ?? null,
    })

  if (error) {
    logger.warn('faq-seed-agent: failed to write agent_runs row', {
      organisation_id: organisationId,
      error: error.message,
    })
  }
}
