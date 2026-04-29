// src/lib/agents/reply-classifier.ts
//
// Classifies incoming email replies using Haiku (claude-haiku-4-5-20251001).
// Per ADR-013: signal processing and batch classification tasks use Haiku.
// Per ADR-018: this is pure intent judgment — LLM is justified. All routing
//   logic (what to DO with the intent) lives deterministically in the processor.
//
// Input:  email body text + subject (always pass subject — OOO classification depends on it)
// Output: ClassificationResult | null
//   null means the Haiku call itself failed — caller writes action_taken = 'classifier_failed'.
//   'unclear' intent is a successful classification — Haiku read the message and couldn't decide.
//
// Full intent taxonomy (8 values):
//   opt_out                     — suppress immediately (any confidence)
//   out_of_office               — log only, Instantly handles natively (any confidence)
//   positive_direct_booking     — send Calendly reply (confidence >= 0.90 only)
//   positive_passive            — log_only in Phase 1; Phase 2 adds nurture handler
//   information_request_generic — log_only in Phase 1; Phase 2 adds FAQ-match handler
//   information_request_commercial — log_only in Phase 1; Phase 2 adds escalation handler
//   objection_mild              — log_only in Phase 1; Phase 2 adds re-engagement handler
//   unclear                     — log_only (any confidence)
//
// Phase 1 processor acts on: opt_out, out_of_office, positive_direct_booking.
// All others → action_taken = 'log_only'. Taxonomy is stable; handlers are additive.

import Anthropic from '@anthropic-ai/sdk'
import type { TextBlock } from '@anthropic-ai/sdk/resources/messages'
import { logger } from '@/lib/logger'

const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001'

export type ReplyIntent =
  | 'opt_out'
  | 'out_of_office'
  | 'positive_direct_booking'
  | 'positive_passive'
  | 'information_request_generic'
  | 'information_request_commercial'
  | 'objection_mild'
  | 'unclear'

const VALID_INTENTS = new Set<string>([
  'opt_out',
  'out_of_office',
  'positive_direct_booking',
  'positive_passive',
  'information_request_generic',
  'information_request_commercial',
  'objection_mild',
  'unclear',
])

export interface ClassificationResult {
  intent: ReplyIntent
  confidence: number     // 0.0–1.0
  reasoning: string
}

const SYSTEM_PROMPT = `You classify B2B cold email replies. Output JSON only — no other text.

Intent taxonomy:
  opt_out                      — any refusal, explicit or implicit. Covers: "stop", "remove me",
                                 "not interested", "leave me alone", hostile language, and any
                                 unmistakable refusal regardless of exact wording. One signal is enough.
  out_of_office                — automated OOO or vacation auto-reply. No human authored this message.
  positive_direct_booking      — prospect expresses clear, active interest in booking a call or meeting.
                                 Forward-looking and specific. May or may not use the word "book".
  positive_passive             — interest expressed but no booking ask. Prospect is engaged and warm
                                 but not yet ready to commit ("interesting, tell me more", "I'd be
                                 open to hearing more", "send me some info").
  information_request_generic  — general questions likely answerable from standard FAQs. Examples:
                                 "do you work with companies my size", "what's your typical timeline",
                                 "what industries do you focus on".
  information_request_commercial — specific pricing, contract, technical, or commercial questions
                                 outside FAQ scope and requiring a human to answer. Examples:
                                 "what do you charge", "how does the contract work", "do you integrate
                                 with our stack".
  objection_mild               — soft friction, not hostile. Prospect is not refusing but is pushing
                                 back or deferring. Examples: "not the right time", "come back next
                                 quarter", "we're happy with what we have for now".
  unclear                      — intent genuinely ambiguous after reading the full message.

Decision rules (apply in order):
  1. OOO takes priority: if the message is clearly automated, classify as out_of_office
     regardless of any other content. Subject line is a strong signal.
  2. When in doubt between opt_out and unclear: choose opt_out. Missing an opt-out is worse
     than suppressing an ambiguous message.
  3. When in doubt between positive_direct_booking and positive_passive: choose positive_passive.
     A Calendly link sent to a passive prospect is premature; escalating a warm reply is recoverable.
  4. When in doubt between information_request_generic and information_request_commercial: choose
     information_request_commercial. Routes to human escalation rather than a failed FAQ match.
  5. When in doubt between any classified intent and unclear: choose unclear.

Respond with raw JSON only. No markdown. No code fences. No explanation before or after.
Exact output format:
{"intent":"unclear","confidence":0.85,"reasoning":"One sentence explaining the classification."}`

export async function classifyReply(
  emailBody: string,
  subject?: string,
): Promise<ClassificationResult | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    logger.error('reply-classifier: ANTHROPIC_API_KEY not set')
    return null
  }

  const client = new Anthropic({ apiKey })

  const userMessage = subject
    ? `Subject: ${subject}\n\nReply body:\n${emailBody}`
    : `Reply body:\n${emailBody}`

  let raw: string
  try {
    const response = await client.messages.create({
      model: CLASSIFIER_MODEL,
      max_tokens: 200,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    })

    const textBlock = response.content.find((b): b is TextBlock => b.type === 'text')
    if (!textBlock) {
      logger.error('reply-classifier: no text block in Haiku response')
      return null
    }
    raw = textBlock.text.trim()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('reply-classifier: Haiku call failed', { error: msg })
    return null
  }

  // Strip markdown code fences if Haiku wraps the JSON despite instructions.
  const jsonString = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(jsonString)
  } catch {
    logger.error('reply-classifier: failed to parse Haiku JSON output', { raw })
    return null
  }

  const intent = parsed.intent as string | undefined
  const confidence = parsed.confidence as number | undefined
  const reasoning = parsed.reasoning as string | undefined

  if (!intent || !VALID_INTENTS.has(intent)) {
    logger.error('reply-classifier: unexpected intent value in Haiku output', { intent, raw })
    return null
  }

  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
    logger.error('reply-classifier: invalid confidence in Haiku output', { confidence, raw })
    return null
  }

  if (!reasoning || typeof reasoning !== 'string') {
    logger.error('reply-classifier: missing reasoning in Haiku output', { raw })
    return null
  }

  return {
    intent: intent as ReplyIntent,
    confidence: Math.round(confidence * 1000) / 1000,
    reasoning,
  }
}
