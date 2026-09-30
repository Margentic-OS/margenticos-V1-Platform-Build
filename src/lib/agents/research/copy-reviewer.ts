// AN AUTOMATED READER APPLYING THE OPERATOR'S RUBRIC. IT RECORDS AND NEVER BLOCKS.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT IT IS FOR. Every gate in this codebase answers one narrow question about a string.
// The operator reads the whole email and asks a different kind of question: is this true, is
// it a guess, does it follow, is it about the right thing. Those are the questions that keep
// finding faults the gates pass, and a person can only ask them of a sample.
//
// SO THIS IS NOT A GATE AND MUST NOT BECOME ONE WITHOUT A NUMBER. It writes verdicts to
// copy_review_verdicts and nothing reads them to decide anything. An automated reader is
// worth switching on once its agreement with the operator's own reading is known on BOTH the
// fails AND the passes, and that number cannot exist until the two have read the same copy.
// A reviewer that agrees only on fails is a reviewer that rejects everything.
//
// THERE IS CURRENTLY NO SOFT CATEGORY. "The bridge does not follow from the fact" was one
// until 2026-09-30 and is now a hard fail on the operator's marks: an argument merely attached
// to a fact reads as a non-sequitur to the person receiving it, whatever else is correct. The
// soft list and its column remain, because the distinction is real and the next category of
// its kind should not have to reintroduce the machinery.
//
// RULE ZERO. Nothing below names a client, a market, a service or a buyer. The rubric is a
// list of ways a sentence can be wrong about a stranger, and it is the same list whoever is
// writing. What the service actually does reaches this file only as the client's own
// positioning document, passed in at runtime.

import Anthropic from '@anthropic-ai/sdk'
import { createHash } from 'node:crypto'
import { logger } from '@/lib/logger'
import { throwIfFatal } from '@/lib/agents/fatal-api-error'
import { ZERO_TOKEN_USAGE, readTokenUsage, type TokenUsage } from './types'

export const COPY_REVIEW_MODEL = 'claude-sonnet-4-6'

/**
 * The operator's hard-fail rubric, as written. Each entry is a way a sentence can be wrong
 * about somebody nobody has met.
 *
 * `positions` exists because two of them are not askable everywhere: a follow-up cannot be
 * about a different fact than Email 1 when it IS Email 1, and asking anyway invites an answer.
 */
export const HARD_FAIL_CATEGORIES = [
  {
    id: 'invented_fact',
    positions: [1, 2, 3],
    question: 'Does the email state something about the reader or their company that the findings do not carry?',
  },
  {
    id: 'guess_about_them',
    positions: [1, 2, 3],
    question:
      'Does it assert how their time, money or selling are arranged? How busy they are, what ' +
      'they earn or hold, or who does their selling. None of that is visible from outside.',
  },
  {
    // ═══ ITS OWN CATEGORY, ADDED 2026-09-30 ON THE OPERATOR'S MARKS ═══
    //
    // It was inside guess_about_them as the phrase "who their customers are", and that turned
    // out to be the wrong question. WHERE THE WORK COMES FROM is the guess that keeps being
    // made: by referral, by network, by repeat business, by one big account. Naming it
    // separately is the difference between a reviewer that reports the fault and one that
    // buries it in a category about diaries.
    //
    // A TENSION WITH CLAUDE.md, STATED RATHER THAN RESOLVED HERE. Its style rules list
    // "Most of the pipeline comes from referrals" as copy that SURVIVES BEING WRONG, against
    // "no outreach running" which does not, on the reasoning that the first is a pattern a
    // reader can recognise themselves in. This rubric counts it a fault. Both can hold while
    // the reviewer is REPORT ONLY, because nothing is rejected either way; they cannot both
    // hold the day it gates. That decision is the operator's and is not taken here.
    id: 'guess_about_their_clients',
    positions: [1, 2, 3],
    question:
      'Does it assert where their clients or their work come from? By referral, by network, ' +
      'by repeat business, from one account, from a particular channel. Who pays them and how ' +
      'those people found them is not visible from outside.',
  },
  {
    id: 'audience_claim',
    positions: [1, 2, 3],
    question: 'Does it claim something about who sees, follows or reads their content?',
  },
  {
    id: 'wrong_or_mismatched_fact',
    positions: [1, 2, 3],
    question:
      'Is a fact it states wrong, or attached to the wrong thing? A date, a name, a role or an ' +
      'event that the findings contradict, or that belongs to someone else in them.',
  },
  {
    id: 'third_person',
    positions: [1, 2, 3],
    question: 'Does it talk ABOUT the reader rather than TO them, after the greeting?',
  },
  {
    id: 'followup_about_a_different_fact',
    positions: [2, 3],
    question: 'Does this email argue from a different fact than the one the first email used?',
  },
  {
    id: 'need_the_offer_does_not_serve',
    positions: [1, 2, 3],
    question:
      'Does it offer, or ask about, work that the positioning document does not describe the ' +
      'sender doing? Judge the WORK and the PEOPLE it is done to, not the situation that ' +
      'prompted the email.',
  },
  {
    // ═══ MOVED FROM SOFT TO HARD, 2026-09-30, ON THE OPERATOR'S MARKS ═══
    //
    // It was scored separately and never failed, on the earlier instruction that a judgement
    // about how well an argument lands is a different kind of thing from whether a statement
    // is true. The marks say otherwise: an email whose reason-to-reply is merely ATTACHED to
    // the fact rather than following from it reads as a non-sequitur to the person receiving
    // it, whatever else is correct about it.
    //
    // THE REVERSAL IS RECORDED RATHER THAN TIDIED AWAY, because the earlier reasoning was not
    // wrong about the KIND of judgement; it was wrong about the consequence. Anyone reading
    // the rubric later needs to know the question was asked and answered, or they will move
    // it back.
    id: 'bridge_does_not_follow',
    positions: [1, 2, 3],
    question:
      'Does the reason-to-reply FOLLOW from the fact, or is it merely attached to it? A reason ' +
      'that would read the same beneath any other fact does not follow from this one.',
  },
] as const

export type HardFailCategoryId = (typeof HARD_FAIL_CATEGORIES)[number]['id']

/**
 * SCORED, NEVER FAILED. Currently EMPTY.
 *
 * It held bridge_does_not_follow until 2026-09-30, when the operator's marks moved that to
 * the hard list; see the note beside it there. The array and the soft_notes column stay,
 * because the distinction is real and the next category of its kind should not have to
 * reintroduce the machinery. An empty list here means "nothing is currently scored without
 * counting", which is a state worth being able to read.
 */
export const SOFT_CATEGORIES = [] as ReadonlyArray<{
  id: string
  positions: readonly number[]
  question: string
}>

export interface CategoryVerdict {
  failed: boolean
  /** The sentence it is about, quoted from the email. Empty when nothing failed. */
  quote: string
  why: string
}

export interface CopyReviewResult {
  /** One entry per category ASKED, so a missing category is visible rather than implied. */
  hardFails: Record<string, CategoryVerdict>
  softNotes: Record<string, CategoryVerdict>
  anyHardFail: boolean
  usage: TokenUsage
  raw: string
  /** sha256 of the exact body reviewed. A verdict must never outlive its copy. */
  fingerprint: string
}

export const fingerprintCopy = (body: string): string =>
  createHash('sha256').update(body, 'utf8').digest('hex')

const categoriesFor = (position: number) => ({
  hard: HARD_FAIL_CATEGORIES.filter(c => (c.positions as readonly number[]).includes(position)),
  soft: SOFT_CATEGORIES.filter(c => (c.positions as readonly number[]).includes(position)),
})

export function buildReviewPrompt(position: number): string {
  const { hard, soft } = categoriesFor(position)
  const list = (cs: ReadonlyArray<{ id: string; question: string }>) =>
    cs.map(c => `  ${c.id}\n    ${c.question}`).join('\n\n')

  return `You are reading one email that has already been written and checking it against a
fixed list of faults. You are not rewriting it, not scoring its style, and not deciding
whether it should be sent. For each fault below, answer only whether this email has it.

You are given the NUMBERED FINDINGS the email was written from, the sender's POSITIONING
DOCUMENT, and the EMAIL as the reader receives it.

THE READER IS A STRANGER. The sender has never spoken to them. Everything the email says
about them has to come from the findings, and anything else is a guess however reasonable it
sounds. A statement about a whole market or a kind of company is NOT a guess about this
reader, and is allowed.

FAULTS. Answer each one separately, and quote the sentence when the answer is yes:

${list(hard)}

SCORED SEPARATELY, NOT A FAULT. Answer it the same way; it is recorded on its own and does
not count against the email:

${list(soft)}

QUOTE FROM THE EMAIL, EXACTLY, whenever you answer yes. A fault with no sentence attached
cannot be read back or acted on, and is treated as no fault at all.

Return ONLY this JSON, no prose around it:

{"verdicts":[{"id":"<one of the ids above>","failed":false,"quote":"","why":"<one line>"}]}

Return one entry for EVERY id listed, including the ones that pass.`
}

/** Splits the JSON out of the reply. Absent or malformed reads as "reviewed nothing". */
export function parseReviewResponse(
  raw: string,
  position: number,
): { hardFails: Record<string, CategoryVerdict>; softNotes: Record<string, CategoryVerdict> } {
  const { hard, soft } = categoriesFor(position)
  const hardIds = new Set<string>(hard.map(c => c.id))
  const softIds = new Set<string>(soft.map(c => c.id))
  const hardFails: Record<string, CategoryVerdict> = {}
  const softNotes: Record<string, CategoryVerdict> = {}

  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return { hardFails, softNotes }
  let parsed: { verdicts?: unknown }
  try { parsed = JSON.parse(match[0]) as { verdicts?: unknown } } catch { return { hardFails, softNotes } }
  if (!Array.isArray(parsed.verdicts)) return { hardFails, softNotes }

  for (const v of parsed.verdicts) {
    if (!v || typeof v !== 'object') continue
    const o = v as Record<string, unknown>
    const id = typeof o.id === 'string' ? o.id : ''
    const quote = typeof o.quote === 'string' ? o.quote : ''
    // A FAULT WITH NO SENTENCE IS NOT A FAULT. The prompt says so and this enforces it: a
    // verdict nobody can read back cannot be calibrated against a human reading, and an
    // unquoted yes is the cheapest thing for a model to produce.
    const failed = o.failed === true && quote.trim().length > 0
    const verdict: CategoryVerdict = { failed, quote, why: typeof o.why === 'string' ? o.why : '' }
    if (hardIds.has(id)) hardFails[id] = verdict
    else if (softIds.has(id)) softNotes[id] = verdict
  }
  return { hardFails, softNotes }
}

export interface CopyReviewParams {
  apiKey: string
  /** 1, 2 or 3. Email 4 is always the approved template and is never reviewed. */
  position: number
  /** The email as the reader receives it, composed. */
  body: string
  /** The numbered findings the copy was written from. */
  findingsEvidence: string
  /** The client's positioning document, flattened. */
  positioningText: string
  /** Email 1's body, for the follow-up "different fact" question. Omit for position 1. */
  email1Body?: string | null
  prospectId: string
}

/**
 * Review one email. NEVER THROWS for a model fault, and never blocks anything: a reviewer
 * that cannot run must not become an outage for a feature that only writes to a table.
 */
export async function reviewCopy(params: CopyReviewParams): Promise<CopyReviewResult> {
  const empty: CopyReviewResult = {
    hardFails: {}, softNotes: {}, anyHardFail: false,
    usage: ZERO_TOKEN_USAGE, raw: '', fingerprint: fingerprintCopy(params.body),
  }
  if (!params.body.trim()) return empty

  const client = new Anthropic({ apiKey: params.apiKey })
  const user = [
    '## Numbered findings',
    '',
    params.findingsEvidence || '(none recorded)',
    '',
    ...(params.email1Body ? ['## The first email in the sequence, for reference', '', params.email1Body, ''] : []),
    `## The email under review (position ${params.position})`,
    '',
    params.body,
  ].join('\n')

  let raw = ''
  let usage: TokenUsage = ZERO_TOKEN_USAGE
  try {
    const res = await client.messages.create({
      model: COPY_REVIEW_MODEL,
      max_tokens: 2000,
      temperature: 0,
      system: [{
        type: 'text',
        // The rubric and the positioning document are both constant for a client, so the
        // whole system block is a cacheable prefix across every prospect in a run.
        text: `${buildReviewPrompt(params.position)}\n\n## The sender's positioning document\n\n${params.positioningText}`,
        cache_control: { type: 'ephemeral' },
      }],
      messages: [{ role: 'user', content: user }],
    })
    usage = readTokenUsage(res.usage)
    raw = res.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('')
  } catch (err) {
    throwIfFatal(err, 'copy-reviewer')
    logger.warn('copy-reviewer: the reviewer did not run, nothing is blocked by it', {
      prospect_id: params.prospectId,
      position: params.position,
      error: err instanceof Error ? err.message : String(err),
    })
    return { ...empty, usage }
  }

  const { hardFails, softNotes } = parseReviewResponse(raw, params.position)
  const anyHardFail = Object.values(hardFails).some(v => v.failed)

  logger.info('copy-reviewer: reviewed', {
    prospect_id: params.prospectId,
    position: params.position,
    asked: categoriesFor(params.position).hard.length,
    answered: Object.keys(hardFails).length,
    failed: Object.entries(hardFails).filter(([, v]) => v.failed).map(([k]) => k),
    any_hard_fail: anyHardFail,
  })

  return { hardFails, softNotes, anyHardFail, usage, raw, fingerprint: fingerprintCopy(params.body) }
}
