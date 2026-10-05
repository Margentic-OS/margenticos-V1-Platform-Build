// Is the fact research chose really an instance of the trigger it matched?
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS (operator instruction, 2026-10-03)
//
// A personalised opening argues from the approved reason of the trigger the selected fact
// matched (approved-reason.ts). Which trigger it matched is synthesis's judgement, made
// against a one-line trigger, and a one-line trigger is read generously. The case that
// prompted this: "A job is posted for a delivery or client-facing role" was matched by a
// blog post introducing a new team member whose role nobody checked. A marketing or growth
// hire is not a delivery hire, and an email telling a firm its new hire points to growth
// is wrong about the firm when the hire was in its back office.
//
// So each trigger may carry a DEFINITION, written by the client and approved with the ICP:
// what counts as this event and what does not. Synthesis is shown it. This file reads the
// selected fact against it once more, at the opening stage, because research can REUSE
// stored findings without running synthesis again: a check that lived only inside the
// synthesis prompt would never reach a reused finding.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT IS ASKED, AND WHICH WAY IT FAILS
//
// One question: does the FACT fall within the DEFINITION? A fact that does not show it does
// is outside it. That last rule is the point: a post that names a person and no role cannot
// show the role is the one the definition counts.
//
//   within      the writer runs as before.
//   outside     HELD, exactly as a fact that matched no trigger is held. The model's
//               sentence is recorded as the reason.
//   unusable    an answer that does not parse, has no reason, was cut off, or a call that
//               failed. HELD TOO. An unchecked fact is the thing this check exists to stop,
//               and the cost of a false hold is one prospect going down the ladder to the
//               next Email 1 tier, never a wrong email.
//
// DETERMINISTIC OR MODEL (ADR-018): whether "a new colleague joins the team" is "a hire for
// a client-facing role" is a reading of two pieces of prose. One Haiku call at temperature
// 0, made only when the matched trigger HAS a definition, so a client without definitions
// pays nothing and behaves exactly as before.
//
// RULE ZERO. The prompt names no market, buyer or kind of work. The definition is the
// client's text and is the only place any of that comes from.

import Anthropic from '@anthropic-ai/sdk'
import { logger } from '@/lib/logger'
import { throwIfFatal } from '@/lib/agents/fatal-api-error'
import { ZERO_TOKEN_USAGE, readTokenUsage, type TokenUsage } from './types'

/** A yes-or-no reading of two short pieces of prose. Haiku is enough, and is a third of Sonnet. */
export const TRIGGER_DEFINITION_MODEL = 'claude-haiku-4-5-20251001'
/** The answer is one boolean and one sentence. Room for that, and a cut-off answer holds. */
const MAX_OUTPUT_TOKENS = 200

export const TRIGGER_DEFINITION_SYSTEM_PROMPT = `You decide whether one researched fact is an instance of an event someone has defined.

TRIGGER names a kind of event.
DEFINITION says what counts as that event and what does not. It is the only standard. Apply it as written.
FACT is what research found, with where it was found.

The FACT is within the DEFINITION only if the FACT itself shows that it is. If the FACT does not say enough to show that it counts, it is not within the DEFINITION. Do not assume details the FACT does not state.

Reply with JSON only, no other text:
{"within": true | false, "reason": "<one short sentence saying why, naming what the FACT shows or does not show>"}`

/** The fact as produce-opening has it: the candidate's text and where it was found. */
export interface DefinitionFact {
  observation: string
  source: string
  provenance: string
  date: string | null
}

export type DefinitionVerdict = 'within' | 'outside' | 'unusable'

export interface DefinitionCheckResult {
  verdict: DefinitionVerdict
  /** The model's sentence for within and outside; what went wrong for unusable. */
  why: string
  usage: TokenUsage
  raw: string
}

/** The one method of the SDK client this file uses, so a test can stand one in. */
export interface DefinitionCheckClient {
  messages: {
    create(body: {
      model: string
      max_tokens: number
      temperature: number
      system: string
      messages: Array<{ role: 'user'; content: string }>
    }): Promise<{ content: Array<{ type: string; text?: string }>; usage: unknown; stop_reason?: string | null }>
  }
}

/**
 * Reads the model's reply. null when it is not a verdict: no JSON, `within` not a boolean,
 * or no reason given. Pure, so what code accepts is testable without a model.
 */
export function readDefinitionReply(raw: string): { within: boolean; reason: string } | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  let parsed: unknown
  try { parsed = JSON.parse(raw.slice(start, end + 1)) } catch { return null }
  if (!parsed || typeof parsed !== 'object') return null
  const reply = parsed as Record<string, unknown>
  if (typeof reply.within !== 'boolean') return null
  // A VERDICT WITH NO REASON IS NOT ONE. The reason is what the operator reads when a
  // prospect is held, and a bare "false" gives them nothing to check it against.
  if (typeof reply.reason !== 'string' || reply.reason.trim() === '') return null
  return { within: reply.within, reason: reply.reason.trim() }
}

const UNUSABLE_PREFIX = 'the fact could not be checked against the trigger\'s definition'

export function buildDefinitionUserMessage(trigger: string, definition: string, fact: DefinitionFact): string {
  return [
    `TRIGGER: ${trigger.trim()}`,
    `DEFINITION: ${definition.trim()}`,
    `FACT: ${fact.observation.trim()}`,
    `WHERE IT WAS FOUND: ${fact.source} | ${fact.provenance || 'no provenance'}${fact.date ? ` | dated ${fact.date}` : ''}`,
  ].join('\n')
}

export async function checkFactWithinDefinition(params: {
  apiKey: string
  trigger: string
  definition: string
  fact: DefinitionFact
  prospectId: string
  client?: DefinitionCheckClient
}): Promise<DefinitionCheckResult> {
  // A bounded wait and one retry, as the firm-fact judge has. The SDK default is ten
  // minutes and two retries, which is a stalled research run for one small yes-or-no.
  const client = params.client
    ?? (new Anthropic({ apiKey: params.apiKey, timeout: 60_000, maxRetries: 1 }) as unknown as DefinitionCheckClient)
  let raw = ''
  let usage: TokenUsage = ZERO_TOKEN_USAGE
  let stopReason: string | null | undefined
  try {
    const res = await client.messages.create({
      model: TRIGGER_DEFINITION_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0,
      system: TRIGGER_DEFINITION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildDefinitionUserMessage(params.trigger, params.definition, params.fact) }],
    })
    usage = readTokenUsage(res.usage as Parameters<typeof readTokenUsage>[0])
    stopReason = res.stop_reason
    raw = res.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
  } catch (err) {
    throwIfFatal(err, 'trigger-definition')
    const message = err instanceof Error ? err.message : String(err)
    logger.warn('trigger-definition: the check did not run, the opening is held', {
      prospect_id: params.prospectId, error: message,
    })
    return { verdict: 'unusable', why: `${UNUSABLE_PREFIX}: the call failed (${message})`, usage, raw: '' }
  }

  // A CUT-OFF ANSWER IS NOT AN ANSWER, even one whose visible part parses as a pass. The
  // same rule ADR-059 applies to every truncated model answer here.
  const reply = stopReason === 'max_tokens' ? null : readDefinitionReply(raw)
  const result: DefinitionCheckResult = reply === null
    ? {
        verdict: 'unusable',
        why: stopReason === 'max_tokens'
          ? `${UNUSABLE_PREFIX}: the answer was cut off`
          : `${UNUSABLE_PREFIX}: the answer was not a usable verdict`,
        usage, raw,
      }
    : { verdict: reply.within ? 'within' : 'outside', why: reply.reason, usage, raw }

  logger.info('trigger-definition: checked', {
    prospect_id: params.prospectId,
    verdict: result.verdict,
    why: result.why,
    // The reply itself, when it gave no verdict, so the reason can be read rather than guessed.
    ...(result.verdict === 'unusable' ? { raw: raw.slice(0, 400) } : {}),
  })
  return result
}
