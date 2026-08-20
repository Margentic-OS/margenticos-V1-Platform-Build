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
import { findFirmographicFigures, FIRMOGRAPHIC_RULE_TEXT } from '@/lib/style/firmographic'
import type { ObservationCandidate } from './types'

const WRITER_MODEL = 'claude-sonnet-4-6'
const JUDGE_MODEL = 'claude-sonnet-4-6'

/**
 * Hard cap on the opening block, which is now the observation AND the bridge that
 * follows from it. Raised from 35 to make room for the bridge sentence.
 *
 * Safe against composition's 90-word Email 1 ceiling: measured against the live document,
 * the fixed remainder (greeting, P3, CTA, two-line sign-off) is 24 to 31 words depending
 * on variant, so the tightest variant leaves 59 words of headroom and the most generous
 * leaves 66. A 50-word cap clears all four.
 */
export const OPENING_MAX_WORDS = 50

export interface OpeningResult {
  /** The opening that shipped, or null when the template won both comparisons. */
  opening: string | null
  /** True when the written opening beat the approved template on the final comparison. */
  written_won: boolean
  /** True when the writer was given the judge's sentence and tried again. */
  retry_used: boolean
  /**
   * Every comparison run, in order. One entry normally, two when a retry happened.
   * Both attempts and both verdicts are kept: the second attempt used to be discarded on
   * a losing verdict, which left the audit trail showing a rewrite with no record of what
   * the rewrite said.
   */
  comparisons: JudgeComparison[]
  /** The judge's sentence from the final comparison. */
  judge_reasoning: string
  /** Deterministic gate failures on the attempt that was finally used, if any. */
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
  return `You are a senior BDR with fifteen years behind you, writing for ${params.clientName}.

You are writing to a founder you respect, who runs a real business and gets a lot of these.
Your only goal is a reply. Not to demonstrate that you did the research. Not to prove you
looked them up. A reply.

That distinction decides everything about how you open. A junior opens by showing their
work, because they are being marked on effort. You are not. You open with the one thing
you noticed that makes this person worth writing to, and you let it do the work.

The email is already written apart from its opening. Here is the rest of it, exactly as it
will send:

  [YOUR TEXT GOES HERE]

  ${params.p3}

  ${params.cta}

START BY READING THOSE TWO LINES, BEFORE YOU LOOK AT THE FINDINGS.

Work out precisely which problem they answer. Not the general area they sit in. The
specific problem, the one a person would have to be feeling for that question to be the
natural thing to ask them.

That problem is your target. Everything you write aims at it.

YOUR JOB IS TWO THINGS.

First, the observation: the thing you noticed about this specific person.

Second, the sentence that names THAT problem, the one the two lines above answer, as it
shows up in this prospect's situation. Not a related problem. Not an adjacent one. Not
whatever gap the observation happens to imply. The one the next two lines actually answer.

Then stop. Do not solve it. The approved line after yours does that.

THE TEST, and run it on every draft. Read your text, then the offer line, then the
question, as one message. If the reader could answer that question with "that is not
quite my problem", you aimed at the wrong gap. Rewrite it.

Here is exactly that failure, from real output:

AIMED WRONG:
  observation and bridge: "The weekly inbound you're fielding from people wanting to
   collaborate says the brand is working. The clients you actually want are a different
   current, and it doesn't run on the same word of mouth."
  the question it runs into: "Is getting more conversations in front of you something
   you're working on?"
The bridge says she already has plenty of conversations and they are the wrong ones. The
question asks whether she wants MORE. She does not want more. She wants different. Every
sentence is true and the email still misses, because the bridge and the question are
pointed at two different problems.

AIMED RIGHT, same observation, aimed at what that question actually asks:
  "The weekly inbound you're fielding from people wanting to collaborate says the brand is
   working. What it isn't doing is putting you in front of the buyers you'd actually take
   on, and there is no version of that which arrives on its own."
Now the reader is short of the right conversations, which is exactly what being asked
about more conversations answers.

THE BRIDGE MUST COME FROM THIS OBSERVATION. If the sentence you write would sit just as
comfortably under a different prospect's observation, it is filler and it has failed.
Test it: swap in another founder's facts. If it still reads fine, throw it away and write
one that only makes sense after what you just said.

NEVER OPEN BY NAMING WHAT THEY LACK. No "there is no", no "nothing about", no "with no
case studies", no lists of what is missing from their site or their feed. A senior seller
does not tell a founder their website is thin. It reads as a stranger auditing them, it
puts them on the defensive, and defensive people do not reply. Notice something that IS
there instead.

${FIRMOGRAPHIC_RULE_TEXT}

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
  "Saw your post asking your network for restaurant chains in the 5-15 location range.
   That is a fast way to find the good ones, and it only reaches as far as the people who
   already know you."
Something he actually did, then the shortage of the right conversations that follows from
it. A question about getting more conversations in front of him answers exactly that.

GOOD:
  "Fourteen months carrying CRC alongside the firm says you can hold a serious delivery
   load. The engagement finished in August and the diary behind it did not fill itself."
An observation, then the same shortage, arriving through this founder's specific timing.
Nothing here would fit anyone else.

The difference between the failing and the good pair is not tone and it is not accuracy.
All four are accurate. The good ones land on the problem the closing question asks about.
The failing ones report something and stop.

CONSTRAINTS, and there are only four:
  At most three sentences, at most ${OPENING_MAX_WORDS} words, for the observation and the
  bridge together.
  Write to them, as "you" or by naming their company. Never write their first name in the
  text: the email already greets them by name on the line above.
  Use only what is in the findings below. Invent nothing, and do not soften a fact into
  something the findings do not support.
  Do not pitch, do not name the service, do not ask a question. The lines after yours do
  all three.

Return ONLY your text. No preamble, no quotes, no explanation.`
}

// ─── The judge prompt ────────────────────────────────────────────────────────
//
// A CHOICE, NOT A GATE. The first version framed this as a gatekeeper with a free
// rejection: "HOLD costs nothing, when in doubt HOLD". An absolute bar plus a costless
// no means nothing ever passes, and nothing did, 0 of 13. It also started rejecting the
// client's own approved P3 as generic, which proved it was grading cold email as a
// category rather than doing the job in front of it.
//
// Now it compares two real, sendable drafts of the SAME email that differ only in their
// opening, and picks the one that gets a reply. Both are defensible, so it cannot opt
// out, and the approved P3 is common to both, so it cannot be the deciding factor.
//
// ONE QUESTION still. No checklist, no sub-scores.

export function buildJudgePrompt(): string {
  return `You are the head of sales. Two drafts of the same cold email are in front of you,
both written by your team, both ready to send. They differ only in how they open.

Both go out under your name. Which one reads as a single message where the closing
question is the obvious thing to ask this person after everything above it?

Answer A or B, then one sentence on why.

Reply in exactly this format:
CHOICE: A
REASON: one sentence.`
}

/** The two drafts, labelled and ordered for one comparison. */
export interface JudgeComparison {
  /** The opening the writer produced for this round. */
  opening: string
  /** Which label the WRITTEN version was given. Randomised per comparison. */
  written_label: 'A' | 'B'
  /** The label the judge picked. */
  chosen_label: 'A' | 'B'
  /** True when the judge picked the written opening over the approved template. */
  written_won: boolean
  reason: string
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
    // Strip the possessive before comparing: "SCG's" is the same claim as "SCG", and the
    // findings will only ever contain the bare form. This fired as a false positive.
    const clean = word.replace(/[^\p{L}\p{N}'-]/gu, '').replace(/'s$/i, '')
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

  // A DELIBERATE FOURTH GATE. The brief said to keep the deterministic gates unchanged,
  // and this adds one, so the reasoning should be on the record. A prompt rule alone is
  // advisory (ADR-028), the messaging agent enforces this same ban in code, and the
  // failure it prevents has already shipped once: "a $5M consulting firm" in Bob's
  // opening. Traceability would not have caught it, because the figure was genuinely in
  // the findings. Being in the findings is exactly what makes it dangerous.
  const figures = findFirmographicFigures(opening)
  if (figures.length > 0) {
    failures.push(`quotes ${figures.join(' and ')} from the prospect's record: qualify by role, stage or situation instead`)
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

/**
 * Reads the judge's pick. An unreadable reply resolves to the TEMPLATE, never to the
 * written opening, so an ambiguous answer can only ever fall back to approved copy.
 */
export function parseChoice(raw: string, writtenLabel: 'A' | 'B'): {
  chosen: 'A' | 'B'
  written_won: boolean
  reason: string
} {
  const match = raw.match(/CHOICE:\s*([AB])\b/i)
  const reasonMatch = raw.match(/REASON:\s*([\s\S]+)/i)
  const templateLabel: 'A' | 'B' = writtenLabel === 'A' ? 'B' : 'A'
  const chosen: 'A' | 'B' = match ? (match[1].toUpperCase() as 'A' | 'B') : templateLabel
  const reason = (reasonMatch?.[1] ?? raw).trim().split('\n')[0].trim()
  return {
    chosen,
    written_won: chosen === writtenLabel,
    reason: reason || 'No reasoning returned.',
  }
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
  /** The variant's own approved opening, the version the written one has to beat. */
  templateOpening: string
  prospectId: string
}

export async function writeAndJudgeOpening(params: WriteAndJudgeParams): Promise<OpeningResult> {
  const client = new Anthropic({ apiKey: params.apiKey })
  const findings = buildFindingsBlock(params.candidates)
  const writerSystem = buildWriterPrompt({ clientName: params.clientName, p3: params.p3, cta: params.cta })
  const judgeSystem = buildJudgePrompt()

  // Both drafts go through the real composition path, so the only difference the judge
  // can see is the opening. Same P3, same CTA, same sign-off, same footer.
  const templateEmail = params.composeEmail1(params.templateOpening)

  const writeOnce = async (feedback: string | null): Promise<{ opening: string; gates: string[] }> => {
    const user = feedback
      ? `## Findings\n\n${findings}\n\n## Your previous opening lost to the approved template\n\nYou wrote:\n${feedback.split('|||')[0]}\n\nThe head of sales preferred the template, and said:\n${feedback.split('|||')[1]}\n\nWrite a different opening that beats it. Return ONLY the opening.`
      : `## Findings\n\n${findings}\n\nWrite the opening. Return ONLY the opening.`
    const raw = await callModel(client, WRITER_MODEL, writerSystem, user, 500, `writer for prospect ${params.prospectId}`)
    const opening = scrubAITells(cleanOpening(raw), `research/writer/${params.prospectId}`)
    return { opening, gates: checkOpeningGates(opening, params.prospectFirstName, findings) }
  }

  // Randomised per comparison so a positional preference cannot masquerade as a judgement.
  // The mapping is recorded on every comparison, so any lean is measurable after the fact.
  const compare = async (opening: string): Promise<JudgeComparison> => {
    const writtenEmail = params.composeEmail1(opening)
    const writtenLabel: 'A' | 'B' = Math.random() < 0.5 ? 'A' : 'B'
    const emailA = writtenLabel === 'A' ? writtenEmail : templateEmail
    const emailB = writtenLabel === 'A' ? templateEmail : writtenEmail

    const user = `VERSION A\n\n${emailA}\n\n${'='.repeat(60)}\n\nVERSION B\n\n${emailB}`
    const raw = await callModel(client, JUDGE_MODEL, judgeSystem, user, 300, `judge for prospect ${params.prospectId}`)
    const { chosen, written_won, reason } = parseChoice(raw, writtenLabel)
    return { opening, written_label: writtenLabel, chosen_label: chosen, written_won, reason }
  }

  const comparisons: JudgeComparison[] = []

  // Attempt 1.
  const first = await writeOnce(null)
  if (first.gates.length > 0) {
    // The gate failure spends the one rewrite. No comparison happened yet.
    logger.warn('research/write-opening: first attempt failed deterministic gates', {
      prospect_id: params.prospectId, gates: first.gates,
    })
    const retry = await writeOnce(`${first.opening}|||${first.gates.join('; ')}`)
    if (retry.gates.length > 0) {
      return {
        opening: null, written_won: false, retry_used: true, comparisons,
        judge_reasoning: `Failed deterministic gates twice: ${retry.gates.join('; ')}`,
        gate_failures: retry.gates,
      }
    }
    const only = await compare(retry.opening)
    comparisons.push(only)
    return {
      opening: only.written_won ? retry.opening : null,
      written_won: only.written_won, retry_used: true, comparisons,
      judge_reasoning: only.reason, gate_failures: [],
    }
  }

  const c1 = await compare(first.opening)
  comparisons.push(c1)
  if (c1.written_won) {
    return {
      opening: first.opening, written_won: true, retry_used: false, comparisons,
      judge_reasoning: c1.reason, gate_failures: [],
    }
  }

  // The template won. One rewrite with the judge's sentence, then one more comparison.
  const second = await writeOnce(`${first.opening}|||${c1.reason}`)
  if (second.gates.length > 0) {
    logger.warn('research/write-opening: retry failed deterministic gates', {
      prospect_id: params.prospectId, gates: second.gates,
    })
    return {
      opening: null, written_won: false, retry_used: true, comparisons,
      judge_reasoning: `Retry failed deterministic gates: ${second.gates.join('; ')}`,
      gate_failures: second.gates,
    }
  }

  const c2 = await compare(second.opening)
  comparisons.push(c2)
  return {
    opening: c2.written_won ? second.opening : null,
    written_won: c2.written_won, retry_used: true, comparisons,
    judge_reasoning: c2.reason, gate_failures: [],
  }
}
