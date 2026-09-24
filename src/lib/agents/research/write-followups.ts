// Emails 2 and 3, written by their OWN call with their OWN prompt.
//
// ═══════════════════════════════════════════════════════════════════════════════
// WHY THIS IS A SEPARATE CALL, AND WHY SHARING A PROMPT WAS THE BUG
//
// The first version of this feature asked the Email 1 writer for emails 2 and 3 in the
// same response. It was measured on the pinned 33-prospect cohort on 2026-09-21, flag off
// then flag on, same commit and same pinned document, and it degraded Email 1:
//
//     email 1 gate failures     23  ->  66     (0.48 -> 1.08 per attempt, 2.3x)
//     offer_line_echo            0  ->  19     a category absent from the control
//     bridge_sentences           2  ->  22
//     judge wins             28/33  ->  25/33
//     follow-ups that shipped            0 of 33
//
// THE CAUSE IS A CONTRADICTION BETWEEN TWO JOBS, NOT A BUDGET. Email 1's opening may not
// name the service or the mechanism, and its bridge is exactly one sentence. Email 2's
// whole job is to explain how the work runs. Asking one call to do both put the writer in
// a frame where describing the mechanism WAS the task, and it bled upward into the block
// where that is banned. Nineteen prospects reproduced the approved offer line inside an
// opening that forbids it.
//
// It could not be fixed by raising the token ceiling, because the follow-ups were emitted
// AFTER Email 1's fields and so could not starve them. The interference was in the
// framing.
//
// SO THE TWO PROMPTS ARE SEPARATE BECAUSE THE TWO JOBS CONTRADICT EACH OTHER. This is not
// a second copy of the Email 1 prompt and must never become one: it is a much smaller
// prompt stating a different job, and the rules below are written for THIS job rather than
// inherited from a prompt whose rules are about a paragraph that must not pitch.
//
// It also costs less than it looks. Email 1's system prompt is ~12,000 tokens and is sent
// up to three times per prospect. This one is a fraction of that and is sent once or
// twice, so a separate call does not pay the Email 1 prefix twice: it never sends it.
//
// ═══════════════════════════════════════════════════════════════════════════════
// WHEN IT RUNS
//
// ONLY when the personalised Email 1 won, which is the coherence rule. The caller passes
// the Email 1 that actually ships; if there is none, this is never called. That is what
// stops a callback referring to an observation the prospect never received.

import Anthropic from '@anthropic-ai/sdk'
import { logger } from '@/lib/logger'
import { throwIfFatal } from '@/lib/agents/fatal-api-error'
import { scrubAITells } from '@/lib/style/customer-facing-style-rules'
import { EMAIL_WORD_LIMITS } from '@/agents/messaging-generation-agent'
import { countWords } from '@/lib/composition/personalization'
import { checkFollowupGates, checkFollowupPairGates, reformatParagraphs } from '@/lib/style/followup-gates'
import {
  composeFollowupBody,
  EMPTY_FOLLOWUP,
  type FollowupReference,
  type FollowupOutcome,
} from './followup-frame'
import { ZERO_TOKEN_USAGE, addTokenUsage, readTokenUsage, type TokenUsage } from './types'

const FOLLOWUP_MODEL = 'claude-sonnet-4-6'

/**
 * Attempts, including the first. TWO, not three.
 *
 * Email 1 buys a third attempt with strong material because falling back there costs the
 * personalised opening, which is the email that decides whether anything is read. Falling
 * back HERE costs a follow-up and leaves Email 1 untouched, so the same spend does not buy
 * the same thing. One retry with specific feedback is worth it because the measured
 * failures were systematic and correctable (sentence length); a third would be paying
 * full price for a diminishing return on the less important email.
 */
const MAX_ATTEMPTS = 2

/**
 * Output ceiling. Two emails of at most ~85 words each is ~250 tokens, and there is no
 * scratch block in this prompt to expand into, which is the whole reason the Email 1
 * writer needs 1100. 700 leaves roughly 2.5x headroom.
 *
 * NO SCRATCH BLOCK, DELIBERATELY. Email 1's writer has one because it has to weigh
 * candidate findings and reject most of them. This call is given the finding already
 * chosen and the email already written, so there is nothing to deliberate about, and a
 * think-block placed before the email fields is exactly what produced 0 of 33 judge wins
 * when one was added under a 700-token ceiling.
 */
const MAX_OUTPUT_TOKENS = 700

/**
 * Sonnet's minimum cacheable prefix, in tokens. Below this a cache_control breakpoint is
 * SILENTLY IGNORED: no error, no warning, and the only symptom is the input cost of every
 * call roughly quadrupling from a cache read to a full uncached read.
 *
 * This is why the floor and judge prompts in write-opening.ts are deliberately NOT cached:
 * at ~124 tokens each a breakpoint on them would be ignored while still consuming one of
 * the four allowed per request.
 */
export const SONNET_MIN_CACHEABLE_TOKENS = 1024

/**
 * Characters per token, for estimating prompt size without a tokeniser.
 *
 * DELIBERATELY CONSERVATIVE. English prose runs about 4 characters per token; 3.7 makes
 * the estimate report FEWER tokens than the real count, so the guard fires before the real
 * floor is reached rather than after it. An optimistic divisor would let the prompt cross
 * the floor while the test still passed, which is the one outcome the test exists to stop.
 */
export const CHARS_PER_TOKEN = 3.7

/** Estimated tokens in a prompt string. See CHARS_PER_TOKEN for why this errs low. */
export function estimateTokens(text: string): number {
  return Math.round(text.length / CHARS_PER_TOKEN)
}

export interface FollowupResult {
  email2: FollowupOutcome
  email3: FollowupOutcome
  usage: TokenUsage
  /** How many rewrite attempts ran after the first. 0 or 1. */
  retries_used: number
  /** Every attempt's prose and verdict, kept so a rejection can be read and not just counted. */
  attempts: {
    attempt: number
    email2: string
    email3: string
    failures2: string[]
    failures3: string[]
  }[]
}

/**
 * The follow-up writer's system prompt.
 *
 * A CONSTANT, so it caches. Everything that varies per prospect is in the user message.
 * At roughly 2,000 tokens it is above Sonnet's 1,024-token minimum cacheable prefix, so
 * the breakpoint is real rather than silently ignored, and a serial run keeps it warm
 * across prospects on the default 5-minute TTL.
 *
 * NO WORKED EXAMPLE. The Email 1 prompt records seven occasions on which one of its own
 * examples came back near-verbatim, and twice chooses to name a shape rather than show
 * one. There is no safe example available here in any case: any example of an Email 2 is
 * an example of some client's Email 2, and every word in it would be usable, which is what
 * makes it dangerous. The standard is set by the client's own approved copy, passed at
 * runtime with its opening paragraph already removed.
 *
 * RULE ZERO: nothing in this string is industry-specific, and nothing names a buyer type.
 */
export function buildFollowupSystemPrompt(): string {
  const L = EMAIL_WORD_LIMITS
  return `You write the second and third emails of a four-email sequence, for one specific person.

The first email has already been sent. You will be shown it in full. It opened by naming
something real about this person's business, and it made an offer. You are writing what
comes next.

## THE JOB

EMAIL 2 SAYS HOW THE WORK ACTUALLY RUNS.

Email 1 named a problem and said what changes. It did not say how, on purpose. That is this
email's job: describe the mechanism, plainly, as it bears on the thing email 1 observed.

Not proof. Not a result. Not a client story. There are none, and inventing one is the worst
thing you could do here. Say what happens, who does it, and what the reader stops doing.

EMAIL 3 TAKES A DIFFERENT ANGLE ON THE SAME FINDING.

If the findings hold a second usable fact, use it. If they do not, stay on the first one and
come at it from a different consequence: what it costs somewhere else, what it makes harder
later, how it looks from another seat.

A different angle. Never a second topic, and never the same point said again.

ONE FINDING, DEVELOPED ACROSS THE THREE. Do not introduce new research. Do not restate
email 1.

## HOW EACH ONE OPENS

The first sentence is a callback, and it is about THIS READER.

It points at the specific thing email 1 observed, in a few words, and it says "you" or names
their company. That is what makes it a callback instead of a fresh start.

  It must not open on a population. Not "most", not "many", not "a lot of", not "everyone",
  not "firms that", not "people who", not "the pattern", not "the cost". A sentence that
  would read the same in an email to somebody else is not a callback.

  It must not say when the last email went out, how long ago, or that there was no reply.
  You do not know any of that. The gap between sends is set elsewhere and varies per person,
  so every such sentence is a guess that is wrong for somebody.

  These are banned outright, in any wording: "just following up", "I never heard back",
  "hope this finds you well", and every close relative of them. They say you are writing
  again and have nothing to add.

## LENGTH, WHICH IS WHERE THIS GOES WRONG

Measured on a real run of this task: 24 of 25 attempts came back too long. Not because four
sentences cannot fit. Because the sentences ran 27 to 40 words each.

So the budget is PER SENTENCE, and it is the thing to hold:

  Aim for 12 to 18 words a sentence. Four or five sentences.
  No sentence over 24 words. This is enforced in code and rejects the email.

That arithmetic works: five sentences of 16 words is 80. Five of 30 is 150, and no amount of
cutting sentences afterwards recovers it. Write short sentences from the first draft.

The whole of email 2 must land between ${L.email2MinWords} and ${L.email2MaxWords} words, and
email 3 between ${L.email3MinWords} and ${L.email3MaxWords}, counted with the greeting line and
the two sign-off lines included. Those three lines are about 3 words, so your own prose has
roughly ${L.email2MaxWords - 3} words in email 2 and ${L.email3MaxWords - 3} in email 3.

EMAIL 3 IS NO LONGER THAN EMAIL 2.

Four real sentences beats six short ones padded out. If it could be deleted without losing
anything, delete it.

## WHAT YOU WRITE, AND WHAT YOU DO NOT

WRITE THE MIDDLE ONLY. The greeting line and the two sign-off lines are added afterwards and
are not yours. Do not write a greeting. Do not write a sign-off. Do not sign a name.

Start at the first sentence of real copy. Stop after the closing question.

One question mark per email, and it is the closing question.

Use only what is in the findings and in email 1. Invent nothing.

No figure from their record: no revenue, no headcount, no funding, no money amount. Qualify
by role, stage or situation instead. A wrong number reads as a database lookup.

Never assert what they do NOT have. A problem they can recognise themselves in survives being
wrong. A verdict about them does not.

No dashes of any kind between clauses. Use a full stop, a comma or a colon.

## THE CLIENT'S OWN APPROVED FOLLOW-UPS

You will be shown them, for TONE AND LENGTH ONLY.

Read them for how this client sounds, how long their sentences run, how they describe their
own work, and how they ask. They are NOT an opening model: their first paragraphs have been
removed before you saw them, because those open on a population and you must not.

Do not reproduce a phrase from them. Six consecutive words in common is treated as copying
and the email is thrown away.

## RETURN

Exactly two labelled blocks and nothing else, in this order:

EMAIL2: <the middle of email 2, paragraphs separated by a blank line>
EMAIL3: <the middle of email 3, paragraphs separated by a blank line>

NO PARAGRAPH HOLDS MORE THAN TWO SENTENCES. A follow-up is read on a phone, in a thread, by
someone who did not reply to the first one. Three sentences in one block is where a follow-up
stops being read. Break at the blank line instead, or cut the sentence carrying least.

EMAIL 3 MAY OPEN ON A SENTENCE OF CONTEXT, but it must say "you" or name their company
somewhere in its FIRST PARAGRAPH. Email 2 arrives closest to the first message and points
straight away: its FIRST SENTENCE says "you" or names the company.`
}

export interface WriteFollowupsParams {
  apiKey: string
  clientName: string
  /** Who is reading it, already resolved by resolveBuyer at the shared chokepoint. */
  buyer: string
  /**
   * THE EMAIL 1 THAT ACTUALLY SHIPS, rendered exactly as the prospect receives it.
   *
   * The rendered artifact rather than the observation alone, because the callback has to
   * point at what was actually said, and the composed email is the only place the observed
   * paragraph, the offer line and the question exist together in their final wording.
   */
  email1Body: string
  /** The approved offer line from email 1, for the narrow offer-line echo gate. */
  offerLine: string
  /** The findings block, so email 3 can reach a second fact where one exists. */
  findings: string
  /**
   * WHY THIS PROSPECT HAS A REASON, the same sentence Email 1's second line states. Emails
   * 2 and 3 argue from it rather than choosing an angle of their own, so the sequence makes
   * one case four times instead of four cases once. Optional: a run that reached no winner
   * has none, and the prompt then reads as it did before this existed.
   */
  prospectReason?: string | null
  /** The second event supporting that reason, where there is one. */
  supportingEvent?: string | null
  /** The gates' evidence corpus, which is narrower than the prompt block. */
  findingsEvidence: string
  reference: FollowupReference
  prospectId: string
}

/** Splits the two labelled blocks. Absent means empty string, never undefined. */
export function parseFollowupOutput(raw: string): { email2: string; email3: string } {
  const m2 = raw.match(/EMAIL2:\s*([\s\S]*?)(?=\n\s*EMAIL3:|$)/i)
  const m3 = raw.match(/EMAIL3:\s*([\s\S]+)/i)
  const clean = (t: string) =>
    t.replace(/^(here (?:is|are)[^\n:]*:|email\s*[23]\s*:)\s*/i, '').trim()
  // REFORMATTED HERE, before any gate sees it, so every check runs on the text that ships.
  // Paragraph length is the one fault with a correct answer computable without asking the
  // model again, and spending a retry on it costs a prospect their personalised follow-ups.
  return { email2: reformatParagraphs(clean(m2?.[1] ?? '')), email3: reformatParagraphs(clean(m3?.[1] ?? '')) }
}

export async function writeFollowups(params: WriteFollowupsParams): Promise<FollowupResult> {
  const client = new Anthropic({ apiKey: params.apiKey })
  const system = buildFollowupSystemPrompt()

  let usage: TokenUsage = ZERO_TOKEN_USAGE
  const attempts: FollowupResult['attempts'] = []

  const baseUser = [
    `## Who this is for`,
    ``,
    `You are writing for: ${params.clientName}`,
    `Who you are writing to: ${params.buyer}`,
    ``,
    `## The email already sent`,
    ``,
    params.email1Body,
    ``,
    `## The findings behind it`,
    ``,
    params.findings,
    ``,
    // THE REASON, ABOVE THE REFERENCE COPY. Emails 2 and 3 argue the same thing Email 1 did
    // rather than choosing a fresh angle each, which is how one reader ends up receiving
    // four separate cases. Absent on a run that reached no winner, and the block then reads
    // exactly as it did before this existed.
    ...(params.prospectReason?.trim() ? [
      `## The one thing all four emails argue`,
      ``,
      params.prospectReason.trim(),
      ``,
      `Emails 2 and 3 come back to this. They may approach it from a different side, but they`,
      `do not introduce a different reason, and they do not restate it word for word.`,
      ``,
    ] : []),
    ...(params.supportingEvent?.trim() ? [
      `## A second event pointing at the same reason`,
      ``,
      params.supportingEvent.trim(),
      ``,
    ] : []),
    `## The client's approved follow-ups, for tone and length only`,
    ``,
    // THE HEADING TELLS THE TRUTH ABOUT WHAT IS UNDER IT. When one position's reference
    // strips to nothing, the sibling's stands in, and saying so costs one line. A writer
    // that copies what it is shown must at least know what it is looking at: the register
    // transfers, the JOB does not, and the job is stated above in ## THE JOB.
    ...(params.reference.borrowedPosition !== null ? [
      `Their email ${params.reference.borrowedPosition} has no usable reference of its own, so`,
      `the other one stands in for it below. Read it for register and length only. The two`,
      `emails do DIFFERENT jobs, and the job of each is stated above, not in this sample.`,
      ``,
    ] : []),
    `Their email 2, opening paragraph and closing question removed:`,
    params.reference.reference2,
    ``,
    `Their email 3, opening paragraph and closing question removed:`,
    params.reference.reference3,
  ].join('\n')

  let feedback: string | null = null

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const user = feedback
      ? `${baseUser}\n\n## Your previous attempt was rejected\n\n${feedback}\n\nWrite a different version that answers every point above. Return ONLY the two labelled blocks.`
      : `${baseUser}\n\nWrite the middle of email 2 and the middle of email 3. Return ONLY the two labelled blocks.`

    let text: string
    try {
      const res = await client.messages.create({
        model: FOLLOWUP_MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        // Unpinned temperature, matching every other model call in this pipeline. The
        // reasoning is written out once at the Email 1 writer's call site: variety between
        // prospects is the property the surrounding machinery is built to guarantee, and
        // pinning pushes against it.
        //
        // CACHED. This system prompt is a constant and is well above Sonnet's 1,024-token
        // minimum cacheable prefix, so unlike the floor and judge prompts the breakpoint
        // is real rather than silently ignored.
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: user }],
      })
      usage = addTokenUsage(usage, readTokenUsage(res.usage))
      const block = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text')
      text = block?.text?.trim() ?? ''
    } catch (err) {
      throwIfFatal(err, `followups for prospect ${params.prospectId}`)
      throw err
    }

    const parsed = parseFollowupOutput(text)
    const scrub = (t: string) => (t ? scrubAITells(t, `research/followups/${params.prospectId}`) : '')
    const prose2 = scrub(parsed.email2)
    const prose3 = scrub(parsed.email3)

    const outcome = gate(prose2, prose3, params)
    attempts.push({
      attempt: i,
      email2: prose2,
      email3: prose3,
      failures2: outcome.email2.failures,
      failures3: outcome.email3.failures,
    })

    if (outcome.email2.prose !== null) {
      return { ...outcome, usage, retries_used: i, attempts }
    }

    feedback = [
      'You wrote, as email 2:',
      prose2 || '(nothing)',
      '',
      'and as email 3:',
      prose3 || '(nothing)',
      '',
      'Rejected for:',
      ...[...new Set([...outcome.email2.failures, ...outcome.email3.failures])].map(f => `- ${f}`),
    ].join('\n')
  }

  logger.warn('research/write-followups: every attempt rejected, template follow-ups will ship', {
    prospect_id: params.prospectId,
    attempts: attempts.length,
    reasons: attempts[attempts.length - 1]?.failures2.concat(attempts[attempts.length - 1].failures3),
  })
  const last = attempts[attempts.length - 1]
  return {
    email2: { prose: null, body: null, discarded: last?.email2 || null, failures: last?.failures2 ?? [] },
    email3: { prose: null, body: null, discarded: last?.email3 || null, failures: last?.failures3 ?? [] },
    usage,
    retries_used: MAX_ATTEMPTS - 1,
    attempts,
  }
}

/**
 * Compose, measure and gate one attempt. Pure: no model call, no clock, no database.
 *
 * PRESENCE IS A NAMED FAILURE, NOT AN EMPTY FIELD. EMAIL3 is the last block emitted, so a
 * reply cut off by the token ceiling loses it first, and that reads as a copy fault unless
 * it is reported as a truncation.
 */
function gate(
  prose2: string,
  prose3: string,
  params: WriteFollowupsParams,
): { email2: FollowupOutcome; email3: FollowupOutcome } {
  const missing: string[] = []
  if (!prose2 && !prose3) missing.push('the writer returned neither EMAIL2 nor EMAIL3')
  else if (!prose3) {
    missing.push(
      'the writer returned EMAIL2 but no EMAIL3, which is what a reply cut off by the ' +
      'token ceiling looks like: EMAIL3 is the last block emitted',
    )
  } else if (!prose2) missing.push('the writer returned EMAIL3 but no EMAIL2')

  if (missing.length > 0) {
    return {
      email2: { prose: null, body: null, discarded: prose2 || null, failures: missing },
      email3: { prose: null, body: null, discarded: prose3 || null, failures: missing },
    }
  }

  const body2 = composeFollowupBody(params.reference.templateBody2, prose2)
  const body3 = composeFollowupBody(params.reference.templateBody3, prose3)
  if (body2 === null || body3 === null) {
    const why = ['the template follow-up has no recognisable frame to compose the written prose into']
    return {
      email2: { prose: null, body: null, discarded: prose2, failures: why },
      email3: { prose: null, body: null, discarded: prose3, failures: why },
    }
  }

  const words2 = countWords(body2)
  const words3 = countWords(body3)

  const f2 = checkFollowupGates({
    prose: prose2, position: 2, reference: params.reference.reference2, offerLine: params.offerLine,
    companyName: params.reference.companyName, findingsEvidence: params.findingsEvidence,
    bodyWordCount: words2,
    minWords: EMAIL_WORD_LIMITS.email2MinWords, maxWords: EMAIL_WORD_LIMITS.email2MaxWords,
  })
  const f3 = checkFollowupGates({
    prose: prose3, position: 3, reference: params.reference.reference3, offerLine: params.offerLine,
    companyName: params.reference.companyName, findingsEvidence: params.findingsEvidence,
    bodyWordCount: words3,
    minWords: EMAIL_WORD_LIMITS.email3MinWords, maxWords: EMAIL_WORD_LIMITS.email3MaxWords,
  })

  // The pair gates fail BOTH, because there is no principled way to say which of the two is
  // the wrong one, and shipping one generated follow-up beside one template follow-up
  // breaks the thread: the survivor's callback points at copy the other no longer sets up.
  const pair = checkFollowupPairGates(prose2, prose3, words2, words3)
  const all2 = [...f2, ...pair]
  const all3 = [...f3, ...pair]

  if (all2.length > 0 || all3.length > 0) {
    return {
      email2: { prose: null, body: null, discarded: prose2, failures: all2 },
      email3: { prose: null, body: null, discarded: prose3, failures: all3 },
    }
  }

  return {
    email2: { prose: prose2, body: body2, discarded: null, failures: [] },
    email3: { prose: prose3, body: body3, discarded: null, failures: [] },
  }
}

/** Re-exported so callers importing this module get the empty shape from one place. */
export { EMPTY_FOLLOWUP }
