// Write-in-context plus a single judge.
//
// WHY THIS REPLACES RULE-PATCHING
// The opening used to be written by a step that had never seen the email it lands in.
// It passed every gate and still failed as an email: one opened in the third person
// ("Jason left Pani as Director of Product in July 2024"), another recited the prospect's
// own CV back at him, and none led into the offer line. Each failure produced another
// rule, and rules do not converge on taste.
//
// So the writer now sees the variant's actual P3 and CTA and writes the opening FOR that
// email, and a separate model reads the finished artifact cold and answers one question.
// The six-test scoring survives only as a RANKER of raw material handed to the writer.
// It no longer selects what ships.

import Anthropic from '@anthropic-ai/sdk'
import { logger } from '@/lib/logger'
import { throwIfFatal } from '@/lib/agents/fatal-api-error'
import { scrubAITells } from '@/lib/style/customer-facing-style-rules'
import type { ObservationCandidate } from './types'

const WRITER_MODEL = 'claude-sonnet-4-6'
const JUDGE_MODEL = 'claude-sonnet-4-6'

/** Hard cap on the opening. Two sentences at most, and short ones. */
export const OPENING_MAX_WORDS = 35

export type JudgeVerdict = 'SEND' | 'HOLD'

export interface OpeningResult {
  /** The opening that shipped, or null when the judge held it after the retry. */
  opening: string | null
  verdict: JudgeVerdict
  /** The judge's one sentence of reasoning, from its final read. */
  judge_reasoning: string
  /** True when the writer was given the judge's feedback and tried again. */
  retry_used: boolean
  /** The first attempt, kept even when it was held, so the pair is inspectable. */
  first_attempt: string | null
  /** The judge's sentence on the first read, when a retry happened. */
  first_judge_reasoning: string | null
  /** Deterministic gate failures, if any, on the attempt that was finally used. */
  gate_failures: string[]
}

// ─── The writer prompt ───────────────────────────────────────────────────────
//
// Deliberately almost ruleless. Tonight's failures came from optimising rules, so the
// standard is set by four labelled examples taken from real output rather than by a
// rulebook. Examples get copied, which is exactly why these four are the ones present:
// they define the target better than any description of it would.

export function buildWriterPrompt(params: {
  clientName: string
  p3: string
  cta: string
}): string {
  return `You write the opening line of a cold email for ${params.clientName}.

The email is already written apart from its opening. Here is the rest of it, exactly as it
will send:

  [YOUR OPENING GOES HERE]

  ${params.p3}

  ${params.cta}

Your opening replaces the bracketed line. Everything else is fixed and approved. Write the
opening that makes the whole thing read as one message from one person, and that makes the
line after yours land as the natural next thing to say.

WHAT GOOD LOOKS LIKE, and what does not. These are real openings from this system.

FAILING:
  "Jason left Pani as Director of Product in July 2024 and launched HydrospherIQ three
   months later, with a current headcount of one."
Third person, about him rather than to him. It is a dossier entry. It leads nowhere, and
the offer line after it has nothing to attach to.

FAILING:
  "You left Visteon at SVP level in December 2022. Knot Consulting has been the full focus
   since July 2023."
Second person this time, and still wrong. It recites his own CV back at him. He knows all
of it. Nothing is implied and he has no reason to keep reading.

GOOD:
  "Blue Sky is hiring delivery consultants. There is no blog, no case studies, and no
   content on the site."
Two facts from two different places, put side by side. The problem is implied and never
stated, so the reader draws the conclusion instead of being handed it.

GOOD:
  "Your recent LinkedIn posts are all client work: intern questions, performance reviews.
   UpLevel has been solo since 2018."
An observed pattern next to a plain fact. It sets up an offer about pipeline without
reaching for it, and it could only have been written to this person.

The difference between the failing and the good pair is not tone and it is not accuracy.
All four are accurate. The good ones notice something. The failing ones report something.

CONSTRAINTS, and there are only four:
  At most two sentences, at most ${OPENING_MAX_WORDS} words.
  Write to them, as "you" or by naming their company. Never write their first name in the
  text: the email already greets them by name on the line above.
  Use only what is in the findings below. Invent nothing, and do not soften a fact into
  something the findings do not support.
  Do not pitch, do not name the service, do not ask a question. The lines after yours do
  all three.

Return ONLY the opening. No preamble, no quotes, no explanation.`
}

// ─── The judge prompt ────────────────────────────────────────────────────────
//
// ONE QUESTION. No checklist, no sub-scores, no criteria. The whole design is that taste
// lives in a single holistic judgement, so if the judge misfires the question gets
// sharpened rather than decomposed.
//
// The bar is asymmetric on purpose and the prompt says so: a HOLD costs nothing, because
// the client's own approved opener ships instead, and that opener is good copy.

export function buildJudgePrompt(): string {
  return `You are a senior BDR. A junior on your team drafted this cold email to a real
prospect. Would you send it exactly as written?

Answer SEND or HOLD, then one sentence of reasoning.

Before you answer, know what each answer costs. HOLD costs nothing: the prospect receives
a strong opener the client wrote and approved, so holding is never the expensive choice.
SEND costs a real first impression with a real person, and there is only one.

So when in doubt, HOLD. You are not grading effort and you are not rewarding a draft for
being competent. An email that is technically fine and that a busy founder would skim and
delete is a HOLD. Only SEND what you would put your own name on.

Reply in exactly this format:
VERDICT: SEND
REASON: one sentence.`
}

// ─── Deterministic gates on the writer's output ──────────────────────────────
//
// These three and no others. Everything else is the judge's job. A gate here is for
// things a model should not be asked to self-report: length, whether it slipped into the
// third person, and whether it invented a fact.

/** Numbers, years and proper nouns in the opening that do not appear in the findings. */
function untraceableClaims(opening: string, findingsText: string): string[] {
  const haystack = findingsText.toLowerCase()
  const untraceable: string[] = []

  // Every number and year must come from somewhere.
  for (const token of opening.match(/\b\d[\d,.]*\b/g) ?? []) {
    const bare = token.replace(/[.,]$/, '')
    if (!haystack.includes(bare.toLowerCase())) untraceable.push(bare)
  }

  // Capitalised words that are not sentence-initial read as names of things.
  const words = opening.split(/\s+/)
  words.forEach((word, i) => {
    const clean = word.replace(/[^\p{L}\p{N}'-]/gu, '')
    if (clean.length < 3) return
    if (i === 0) return
    if (!/^\p{Lu}/u.test(clean)) return
    // A capital straight after a full stop is sentence-initial, not a name.
    if (i > 0 && /[.!?]$/.test(words[i - 1])) return
    if (!haystack.includes(clean.toLowerCase())) untraceable.push(clean)
  })

  return [...new Set(untraceable)]
}

export function checkOpeningGates(
  opening: string,
  prospectFirstName: string | null,
  findingsText: string,
): string[] {
  const failures: string[] = []

  const wordCount = opening.trim().split(/\s+/).filter(Boolean).length
  if (wordCount > OPENING_MAX_WORDS) {
    failures.push(`opening is ${wordCount} words, cap is ${OPENING_MAX_WORDS}`)
  }

  if (prospectFirstName && prospectFirstName.trim().length > 1) {
    const re = new RegExp(`\\b${prospectFirstName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    if (re.test(opening)) {
      failures.push(`opening names the prospect ("${prospectFirstName}"), which reads as third person: the greeting above already names them`)
    }
  }

  const untraceable = untraceableClaims(opening, findingsText)
  if (untraceable.length > 0) {
    failures.push(`claims not traceable to any finding: ${untraceable.join(', ')}`)
  }

  return failures
}

// ─── Findings block ──────────────────────────────────────────────────────────

/** Ranked findings with provenance. Ranking is what the six tests are now for. */
export function buildFindingsBlock(candidates: ObservationCandidate[]): string {
  const ranked = [...candidates].sort((a, b) => b.score_total - a.score_total)
  if (ranked.length === 0) return 'No findings.'
  return ranked
    .map((c, i) => `${i + 1}. ${c.observation}\n   source: ${c.source} | ${c.provenance || 'no provenance'}`)
    .join('\n')
}

// ─── Model calls ─────────────────────────────────────────────────────────────

async function callModel(
  client: Anthropic,
  model: string,
  system: string,
  user: string,
  maxTokens: number,
  context: string,
): Promise<string> {
  try {
    const res = await client.messages.create({
      model, max_tokens: maxTokens, system,
      messages: [{ role: 'user', content: user }],
    })
    const block = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text')
    return block?.text?.trim() ?? ''
  } catch (err) {
    throwIfFatal(err, context)
    throw err
  }
}

export function parseVerdict(raw: string): { verdict: JudgeVerdict; reason: string } {
  const verdictMatch = raw.match(/VERDICT:\s*(SEND|HOLD)/i)
  const reasonMatch = raw.match(/REASON:\s*([\s\S]+)/i)
  // Unparseable means the judge did not clearly say SEND. Fail closed.
  const verdict: JudgeVerdict = verdictMatch && /send/i.test(verdictMatch[1]) ? 'SEND' : 'HOLD'
  const reason = (reasonMatch?.[1] ?? raw).trim().split('\n')[0].trim()
  return { verdict, reason: reason || 'No reasoning returned.' }
}

/** Strips quotes or a stray preamble the writer may wrap around the opening. */
function cleanOpening(raw: string): string {
  let text = raw.trim()
  text = text.replace(/^(opening|here is the opening|draft)\s*:\s*/i, '')
  if (/^["'“]/.test(text) && /["'”]$/.test(text)) text = text.slice(1, -1).trim()
  return text
}

export interface WriteAndJudgeParams {
  apiKey: string
  clientName: string
  prospectFirstName: string | null
  candidates: ObservationCandidate[]
  p3: string
  cta: string
  /** Builds the complete Email 1 from an opening, using the real composition path. */
  composeEmail1: (opening: string) => string
  prospectId: string
}

export async function writeAndJudgeOpening(params: WriteAndJudgeParams): Promise<OpeningResult> {
  const client = new Anthropic({ apiKey: params.apiKey })
  const findings = buildFindingsBlock(params.candidates)
  const writerSystem = buildWriterPrompt({ clientName: params.clientName, p3: params.p3, cta: params.cta })
  const judgeSystem = buildJudgePrompt()

  const writeOnce = async (feedback: string | null): Promise<{ opening: string; gates: string[] }> => {
    const user = feedback
      ? `## Findings\n\n${findings}\n\n## Your previous attempt was held\n\nYou wrote:\n${feedback.split('|||')[0]}\n\nThe reviewer said:\n${feedback.split('|||')[1]}\n\nWrite a different opening that answers that. Return ONLY the opening.`
      : `## Findings\n\n${findings}\n\nWrite the opening. Return ONLY the opening.`
    const raw = await callModel(client, WRITER_MODEL, writerSystem, user, 500, `writer for prospect ${params.prospectId}`)
    const opening = scrubAITells(cleanOpening(raw), `research/writer/${params.prospectId}`)
    return { opening, gates: checkOpeningGates(opening, params.prospectFirstName, findings) }
  }

  const judgeOnce = async (opening: string) => {
    const email = params.composeEmail1(opening)
    const raw = await callModel(client, JUDGE_MODEL, judgeSystem, email, 300, `judge for prospect ${params.prospectId}`)
    return parseVerdict(raw)
  }

  // Attempt 1.
  const first = await writeOnce(null)
  if (first.gates.length === 0) {
    const v1 = await judgeOnce(first.opening)
    if (v1.verdict === 'SEND') {
      return {
        opening: first.opening, verdict: 'SEND', judge_reasoning: v1.reason,
        retry_used: false, first_attempt: first.opening, first_judge_reasoning: null, gate_failures: [],
      }
    }
    // Attempt 2, with the judge's sentence as the feedback.
    const second = await writeOnce(`${first.opening}|||${v1.reason}`)
    if (second.gates.length > 0) {
      logger.warn('research/write-opening: retry failed deterministic gates', {
        prospect_id: params.prospectId, gates: second.gates,
      })
      return {
        opening: null, verdict: 'HOLD',
        judge_reasoning: `Retry failed deterministic gates: ${second.gates.join('; ')}`,
        retry_used: true, first_attempt: first.opening, first_judge_reasoning: v1.reason, gate_failures: second.gates,
      }
    }
    const v2 = await judgeOnce(second.opening)
    return {
      opening: v2.verdict === 'SEND' ? second.opening : null,
      verdict: v2.verdict, judge_reasoning: v2.reason,
      retry_used: true, first_attempt: first.opening, first_judge_reasoning: v1.reason, gate_failures: [],
    }
  }

  // First attempt failed a gate: that is the one rewrite attempt, spent on the gate.
  logger.warn('research/write-opening: first attempt failed deterministic gates', {
    prospect_id: params.prospectId, gates: first.gates,
  })
  const retry = await writeOnce(`${first.opening}|||${first.gates.join('; ')}`)
  if (retry.gates.length > 0) {
    return {
      opening: null, verdict: 'HOLD',
      judge_reasoning: `Failed deterministic gates twice: ${retry.gates.join('; ')}`,
      retry_used: true, first_attempt: first.opening, first_judge_reasoning: null, gate_failures: retry.gates,
    }
  }
  const v = await judgeOnce(retry.opening)
  return {
    opening: v.verdict === 'SEND' ? retry.opening : null,
    verdict: v.verdict, judge_reasoning: v.reason,
    retry_used: true, first_attempt: first.opening, first_judge_reasoning: null, gate_failures: [],
  }
}
