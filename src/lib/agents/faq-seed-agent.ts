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
const MAX_TOKENS = 4000

// ── Time budget ───────────────────────────────────────────────────────────────
// This call is large: a Phase A read measured roughly 26,000 input tokens and up to
// 4,000 output on Opus. 4,000 output tokens streamed at the slow end of Opus's range
// is well over two minutes, so the old 60s ceiling could not have completed a
// full-length answer and would have aborted a call that was working.
//
// The two numbers below are deliberately separate, and the overall one is the load
// bearing half. CLAUDE.md records the trap: the Anthropic SDK defaults to a 10 minute
// timeout and 2 retries, which is 30 minutes of retrying against a route that Vercel
// kills at 300s, so the caller never sees the answer OR the error. Here the SDK's own
// retry is switched OFF (maxRetries: 0) and retries are done here instead, each attempt
// bounded by whatever is left of ATTEMPT budget, so worst case is ATTEMPT + remainder,
// never a multiple of it.
const ATTEMPT_TIMEOUT_MS = 150_000
const OVERALL_BUDGET_MS = 240_000
const MAX_ATTEMPTS = 2  // one retry

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
    rawResponse = await callModelWithRetries({ apiKey, systemPrompt, userMessage })
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

  // ── 6. Persist to faq_extractions (best-effort) ────────────────────────────
  await writeFaqExtractionResults(supabase, organisationId, results)

  // ── 7. Log success ─────────────────────────────────────────────────────────
  await writeAgentRun(supabase, {
    organisationId,
    status: 'completed',
    outputSummary: JSON.stringify({
      faq_count: results.length,
      written_to_extractions: results.length,
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

export async function writeFaqExtractionResults(
  supabase: SupabaseClient,
  organisationId: string,
  results: FaqSeedResult[],
): Promise<void> {
  if (results.length === 0) return

  for (const result of results) {
    try {
      await supabase.from('faq_extractions').insert({
        organisation_id: organisationId,
        signal_id: null,  // seed-generated FAQs have no associated signal
        reply_draft_id: null,  // seed-generated FAQs have no associated reply
        extracted_question: result.extracted_question,
        suggested_answer: result.suggested_answer,
        source: 'seed_generated',
        status: 'pending',
        potential_names_flagged: [],
        prompt_version: result.prompt_version,
      })
    } catch (insertErr) {
      const msg = insertErr instanceof Error ? insertErr.message : String(insertErr)
      logger.warn('faq-seed-agent: faq_extractions insert failed (best-effort)', {
        organisation_id: organisationId,
        extracted_question: result.extracted_question.slice(0, 50),
        error: msg,
      })
      // Best-effort: continue with next result even if this one fails
    }
  }
}

/**
 * One streamed Opus call, retried at most MAX_ATTEMPTS times inside OVERALL_BUDGET_MS.
 *
 * Only transient faults are retried. A 4xx that is not 408/429 is the request itself
 * being wrong, and sending it again would burn the remaining budget to receive the same
 * refusal. Retrying is also safe to do at all only because this call has no side effect:
 * nothing is written until the response parses.
 */
async function callModelWithRetries(args: {
  apiKey: string
  systemPrompt: string
  userMessage: string
}): Promise<string> {
  const { apiKey, systemPrompt, userMessage } = args
  const deadline = Date.now() + OVERALL_BUDGET_MS

  // maxRetries: 0 is not a detail. Leaving the SDK's own retry on would multiply every
  // number below by three and put the worst case far past the route's 300s ceiling.
  const client = new Anthropic({ apiKey, maxRetries: 0 })

  let lastError: unknown

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break

    try {
      const stream = client.messages.stream(
        {
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        },
        { signal: AbortSignal.timeout(Math.min(ATTEMPT_TIMEOUT_MS, remaining)) },
      )

      const message = await stream.finalMessage()

      // A truncated answer is a FAILURE with its own reason, never a success (ADR-059).
      // It matters here because the JSON would be cut mid-object and the parse below
      // would report "no JSON object found", sending whoever reads the log looking for a
      // prompt fault when the real cause is the token ceiling.
      if (message.stop_reason === 'max_tokens') {
        throw new TruncatedAnswerError(
          `Opus stopped at the ${MAX_TOKENS} token ceiling, so the answer is truncated and ` +
          'its JSON is incomplete. This is not retried: the same request would truncate again.',
        )
      }

      const textBlock = message.content.find((b): b is TextBlock => b.type === 'text')
      if (!textBlock) {
        throw new Error('No text block in Opus response')
      }
      return textBlock.text.trim()
    } catch (err) {
      lastError = err
      // The loop bound already stops us after MAX_ATTEMPTS. This exists so the final
      // failure is not announced as a retry that never happens.
      const isFinalAttempt = attempt === MAX_ATTEMPTS
      if (isFinalAttempt || !isRetryableModelError(err)) break
      logger.warn('faq-seed-agent: retrying Opus call after a transient failure', {
        attempt,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/**
 * The answer came back whole but too long. Deterministic, so retrying reproduces it
 * exactly; it needs its own type because it carries no HTTP status, and the default for
 * a status-less error below is to retry.
 */
class TruncatedAnswerError extends Error {
  readonly retryable = false
  constructor(message: string) {
    super(message)
    this.name = 'TruncatedAnswerError'
  }
}

/** Transient faults worth a second attempt: transport trouble, rate limits, server faults. */
function isRetryableModelError(err: unknown): boolean {
  // Checked before anything else: this error reaches the status test below with no status,
  // and would otherwise be read as a dropped connection and retried.
  if (err instanceof TruncatedAnswerError) return false

  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return true

  const status = (err as { status?: unknown })?.status
  if (typeof status === 'number') {
    return status === 408 || status === 429 || status >= 500
  }

  // No status at all means the request never reached a response: a socket error, a DNS
  // failure, a dropped stream. All worth one more attempt.
  return true
}

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
