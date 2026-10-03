// Does the email's second line say what the APPROVED reason says, and nothing more?
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY A CHECK, WHEN THE WRITER IS HANDED THE REASON
//
// approved-reason.ts makes the writer argue from the client's approved sentence, verbatim.
// That decides what the writer is TOLD. It does not decide what the writer WRITES, and a
// prompt instruction is advisory (ADR-028).
//
// Measured on the live client, on the four openings whose writer was already handed an
// approved reason verbatim: every one of the four second lines said something the reason
// does not. "Hiring points to growth, and growth needs a steady flow of new clients" came
// back as "every new account manager you hire needs a full client book waiting on their
// first day". The reason is about the firm's direction. The line is a guess about
// somebody's diary, and it is the kind of sentence a reader who is doing fine knows was
// guessed.
//
// So the line is read back against the reason, by a model, and the verdict is checked by
// code where code can check it.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT IS ASKED, AND WHAT CODE VERIFIES
//
// Three questions about the SENTENCE:
//
//   says        the words of the sentence that say what the event means, COPIED from it.
//               Code checks the copy is really in the sentence. A verdict about words the
//               sentence does not contain is not a verdict.
//   same        does the approved reason say that same thing.
//   adds        what the sentence asserts beyond the approved reason, COPIED from the
//               sentence, and only of five named kinds: a deadline, an amount, who has to
//               act, what the reader lacks, how things stand for them today. Code checks
//               that copy too. An addition that is not word for word in the sentence
//               makes the whole reply NO VERDICT: the model saw something and code cannot
//               confirm what, which is not a pass.
//
//               FIVE KINDS, NOT "ANYTHING". The first version asked for anything the reason
//               does not say, and on its first trial it rejected a line for naming the
//               event ("adds account managers"), which is the one thing every second line
//               has to do. An open-ended question about additions finds one in every
//               paraphrase.
//
// A line passes when it says something, the reason says the same, and it adds nothing.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHICH WAY IT FAILS
//
// NO VERDICT IS A REJECTION OF THIS ATTEMPT, not a pass. The writer tries again. The other
// two verifiers in the same loop fail open when they cannot run; this one does not, because
// an unchecked line is exactly the thing this file exists to stop, and the cost of a false
// rejection is one more attempt, never a wrong email.
//
// DETERMINISTIC OR MODEL (ADR-018): whether two sentences say the same thing is a reading.
// One Sonnet call at temperature 0 per attempt that already passed every deterministic gate
// and the fact-check, so nothing is paid to read a line that is about to be rewritten.

import Anthropic from '@anthropic-ai/sdk'
import { logger } from '@/lib/logger'
import { throwIfFatal } from '@/lib/agents/fatal-api-error'
import { ZERO_TOKEN_USAGE, readTokenUsage, type TokenUsage } from './types'

/** The same model the other two verifiers in this loop use, so one price covers all three. */
export const REASON_MATCH_MODEL = 'claude-sonnet-4-6'
const MAX_OUTPUT_TOKENS = 300

export const REASON_MATCH_SYSTEM_PROMPT = `You compare one sentence of an email with a reason that was approved in advance.

APPROVED REASON says what a kind of event means for the firm it happened at.
SENTENCE is the email's second line. It was written about one such event, and it is meant to say what the APPROVED REASON says.

Answer three questions about the SENTENCE.

1. "says": the words of the SENTENCE that say what the event means for the firm. Copy them exactly from the SENTENCE. Use an empty string if the SENTENCE does not say what the event means.

2. "same": "yes" if the APPROVED REASON says that same thing, in any wording. "no" if the SENTENCE points somewhere the APPROVED REASON does not, or says nothing.

3. "adds": claims in the SENTENCE that the APPROVED REASON does not make, of these five kinds ONLY:
   - a time or a deadline by which something has to happen
   - an amount or a quantity
   - who has to do something
   - what the reader or their staff lack or are short of
   - how things stand for the reader today
   Copy each one exactly from the SENTENCE. Nothing else is an addition. Words that name or describe the event are never an addition, even when they mention a date, a number or a role. Saying the reason in other words is not an addition. A general statement about firms is not an addition. Use an empty list when there are none.

Reply with JSON only, no other text:
{"says": "<copied from the SENTENCE, or empty>", "same": "yes" | "no", "adds": ["<copied from the SENTENCE>"]}`

export interface ReasonMatchVerdict {
  says: string
  same: boolean
  /** Only the additions code found in the sentence. */
  adds: string[]
}

export interface ReasonMatchResult {
  /** null when the model gave no usable verdict. */
  verdict: ReasonMatchVerdict | null
  /** Every reason this line must not ship. Empty means it may. */
  failures: string[]
  usage: TokenUsage
  raw: string
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Is this text really in the sentence? Whole words, punctuation and case folded. */
function inSentence(text: string, sentence: string): boolean {
  const needle = normalise(text)
  return needle !== '' && ` ${normalise(sentence)} `.includes(` ${needle} `)
}

/**
 * Reads the model's reply against the sentence it was shown. null when the reply is not a
 * verdict at all. Pure, so the whole of what code verifies is testable without a model.
 */
export function readReasonMatchReply(raw: string, bridge: string): ReasonMatchVerdict | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  let parsed: unknown
  try { parsed = JSON.parse(raw.slice(start, end + 1)) } catch { return null }
  if (!parsed || typeof parsed !== 'object') return null
  const reply = parsed as Record<string, unknown>
  if (typeof reply.says !== 'string') return null
  if (reply.same !== 'yes' && reply.same !== 'no') return null
  if (!Array.isArray(reply.adds)) return null

  // "says" must be words of the sentence. Where it is not, the sentence is treated as
  // saying nothing the model could point to, which fails below.
  const says = inSentence(reply.says, bridge) ? reply.says.trim() : ''
  const cited = reply.adds.filter((a): a is string => typeof a === 'string' && a.trim() !== '')
  // AN OBJECTION THE MODEL COULD NOT QUOTE IS NO VERDICT, NOT A PASS. The first version
  // dropped an addition that was not word for word in the sentence, so that the model could
  // not fail a line for something it did not say. That left one branch where an unverified
  // reply passed: same "yes", with a paraphrased addition, read as a clean match. The model
  // saw something added; code could not confirm what. That is the unchecked line this file
  // exists to stop, so the attempt is rejected and the writer tries again.
  if (cited.some(a => !inSentence(a, bridge))) return null
  return { says, same: reply.same === 'yes' && says !== '', adds: cited.map(a => a.trim()) }
}

/** The failures a verdict produces, worded for the writer's next attempt. */
export function reasonMatchFailures(verdict: ReasonMatchVerdict | null, approvedReason: string): string[] {
  if (verdict === null) {
    return ['the second line could not be checked against the approved reason this attempt, so it is not accepted: write it again, closer to the reason as given']
  }
  const failures: string[] = []
  if (!verdict.same) {
    failures.push(
      `the second line does not say what the approved reason says. The reason is: "${approvedReason}". ` +
      'Say what the event means for the firm, as that reason puts it, and nothing else',
    )
  }
  for (const added of verdict.adds) {
    failures.push(
      `the second line adds something the approved reason does not say: "${added}". ` +
      'Take it out. The line states the reason and stops',
    )
  }
  return failures
}

/** The one method of the SDK client this file uses, so a test can stand one in. */
export interface ReasonMatchClient {
  messages: {
    create(body: {
      model: string
      max_tokens: number
      temperature: number
      system: string
      messages: Array<{ role: 'user'; content: string }>
    }): Promise<{ content: Array<{ type: string; text?: string }>; usage: unknown }>
  }
}

export async function checkBridgeStatesReason(params: {
  apiKey: string
  approvedReason: string
  bridge: string
  prospectId: string
  client?: ReasonMatchClient
}): Promise<ReasonMatchResult> {
  const client = params.client ?? (new Anthropic({ apiKey: params.apiKey }) as unknown as ReasonMatchClient)
  let raw = ''
  let usage: TokenUsage = ZERO_TOKEN_USAGE
  try {
    const res = await client.messages.create({
      model: REASON_MATCH_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0,
      system: REASON_MATCH_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `APPROVED REASON: ${params.approvedReason}\n\nSENTENCE: ${params.bridge}` }],
    })
    usage = readTokenUsage(res.usage as Parameters<typeof readTokenUsage>[0])
    raw = res.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
  } catch (err) {
    throwIfFatal(err, 'reason-match')
    logger.warn('reason-match: the check did not run, this attempt is not accepted', {
      prospect_id: params.prospectId,
      error: err instanceof Error ? err.message : String(err),
    })
    return { verdict: null, failures: reasonMatchFailures(null, params.approvedReason), usage, raw: '' }
  }

  const verdict = readReasonMatchReply(raw, params.bridge)
  const failures = reasonMatchFailures(verdict, params.approvedReason)
  logger.info('reason-match: checked', {
    prospect_id: params.prospectId,
    verdict: verdict === null ? 'no_verdict' : failures.length === 0 ? 'matches' : 'rejected',
    says: verdict?.says ?? null,
    adds: verdict?.adds ?? [],
    // The reply itself, when it gave no verdict, so the reason can be read rather than guessed.
    ...(verdict === null ? { raw: raw.slice(0, 400) } : {}),
  })
  return { verdict, failures, usage, raw }
}
