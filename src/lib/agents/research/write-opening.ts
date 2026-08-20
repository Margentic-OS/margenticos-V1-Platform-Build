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
 * Hard cap on the whole written block: observation, bridge AND closing question.
 *
 * The writer now owns the CTA as well, so the approved CTA no longer consumes budget.
 * Measured against the live document, what remains fixed is the greeting line, the P3
 * offer line and the two sign-off lines: 70 words of headroom on the tightest variant (D)
 * and 74 on the most generous (C). A 62-word cap clears all four with at least 8 words to
 * spare, and a test pins the cap below the measured minimum so a future raise cannot
 * silently breach the 90-word ceiling.
 */
export const OPENING_MAX_WORDS = 62

export interface OpeningResult {
  /** The opening that shipped, or null when the template won or the floor disqualified it. */
  opening: string | null
  /** The closing question that shipped, set and cleared together with `opening`. */
  question: string | null
  /** True when the written opening beat the approved template on the final comparison. */
  written_won: boolean
  /** True when the writer was given feedback and tried again at least once. */
  retry_used: boolean
  /** How many rewrite attempts ran after the first. 0, 1 or 2. */
  retries_used: number
  /**
   * True when the prospect had at least one candidate passing all six tests, which is
   * what buys the second retry. Weak material keeps one and falls back as before.
   */
  strong_material: boolean
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

Here is the email, exactly as it will send. You write the two bracketed parts:

  [YOUR OBSERVATION AND BRIDGE GO HERE]

  ${params.p3}

  [YOUR CLOSING QUESTION GOES HERE]

The offer line in the middle is FIXED. It is the client's positioning and what they
approved. Do not alter it, do not paraphrase it, do not work around it.

For reference, the approved closing question for this variant is:
  "${params.cta}"
Use it only if it is genuinely the right question for this prospect. Otherwise write one
that fits them better, in the same register.

START BY READING THE OFFER LINE, BEFORE YOU LOOK AT THE FINDINGS.

Work out precisely which problem it answers. Not the general area it sits in. The specific
problem, the one a person would have to be feeling for that offer to be worth reading.

That problem is your target. Everything you write aims at it.

YOUR JOB IS TWO THINGS.

First, the observation: the thing you noticed about this specific person. You can see what
they posted, what they published, who they hired, where they spoke, what roles they have
held and when. Say one of those.

Second, the bridge: a sentence naming the problem your target is, as a PATTERN that is
typically true of firms in the situation you just described.

Third, the closing question. It goes where [YOUR CLOSING QUESTION GOES HERE] sits, after the offer
line. It is the obvious thing to ask THIS person once they have read the observation, the
bridge and the offer line above it. One question, ending in a question mark. Low
commitment and easy to answer. No meeting request, no calendar link, no "worth a call".

These four are the client's own approved closing questions. Match their register and their
length. Do not copy one verbatim unless it genuinely is the right question for this
prospect:
  "Is pipeline consistency something you're actively trying to fix?"
  "Is getting more conversations in front of you something you're working on?"
  "Is this a gap you're looking to close?"
  "Worth a look to see if it fits where you are?"

THE QUESTION MUST ASK ABOUT THE PROBLEM YOU JUST NAMED. This is where a fixed question
used to go wrong, and the failure is worth reading:

FAILING, three rewrites running:
  bridge: "Firms that make that shift often find the product side builds an audience of
   browsers before it builds a pipeline of buyers."
  question it ran into: "Is getting more conversations in front of you something you're
   working on?"
The bridge diagnoses her correctly: she has an audience, and the wrong kind. Then the
question asks whether she wants MORE conversations. She does not want more. She wants
different ones. The email diagnoses her and then asks about somebody else's problem.

CORRECTED, same bridge, asking about what was actually named:
  "Is turning that audience into the right kind of buyer something you're working on?"
Same register, same length, and now it asks about the problem the email just described.

THE BRIDGE NAMES A PATTERN. IT NEVER DELIVERS A VERDICT.

This is the rule that matters most and the one most easily broken. You can see what they
did. You cannot see their pipeline, their calendar, their marketing results, or whether
any of it is working. Writing as though you can is presumptuous, it is frequently wrong,
and a founder who reads a wrong claim about their own business stops reading.

So the bridge may say what is TYPICALLY true of firms in this position. It may never say
what IS true of this prospect's pipeline, diary, marketing or results.

And never tell them something they are doing is not working. Their network, their events,
their content, their brand may all be working perfectly. You have no way of knowing, and
that is precisely the sentence that earns a defensive reply instead of a meeting.

VERDICT, and this one is not just presumptuous but wrong:
  observation: "The hiring post for a Manager of Delivery and Operations says the client
   load is real and growing."
  bridge: "What a Chamber event and a strong network cannot do is put Blue Sky in front of
   the right buyers before that new capacity is already spoken for."
A chamber event and a strong network is exactly how a great many consultancies fill
capacity. We told him the thing that works does not work.

PATTERN, same observation, corrected:
  "The hiring post for a Manager of Delivery and Operations says the client load is real
   and growing. Firms that add delivery capacity on the back of a strong local network
   often find the network fills the first months and not the ones after that."
Nothing here claims his network has failed. It names what tends to happen next, and leaves
him to decide whether it is happening to him.

VERDICT again, invented outright:
  "Eleven years in, a firm that size fills its diary through relationships, and
   relationships only reach so far."
We have no idea how Taffet fills its diary. We made it up and then built on it.

PATTERN, the two Doug accepted, and they are worth reading twice:
  "That kind of operational weight tends to be exactly where new client conversations get
   quietly deprioritised."
  "That tends to be when the next engagement goes uncontested to whoever stayed visible."
Both say what TENDS to happen. Neither claims to know what is happening here.

PATTERN FRAMING IS NOT PERMISSION TO GO GENERIC.

The pattern must be one that only applies because of what you just observed. This is the
harder half of the job.

  Generic, and therefore useless: "Most firms at this stage find pipeline slips."
It is safe, it obeys every rule above, and it says nothing. The approved paragraph further
down the email already makes that point, so you have added a line and no information.

THE TEST: read your bridge on its own, without the observation above it. If it still makes
sense as a standalone sentence, it is generic and it has failed. A good bridge reads as a
non-sequitur without its observation, because it depends on it entirely.

ONE FACT PER SENTENCE.

This is the last thing standing between these emails and being good, and it is about
STRUCTURE, not length. A short sentence carrying three facts is still a second read.

If you are naming two things, use two sentences. Do not join facts with appositives. Do
not bury a list mid-sentence. Never separate a subject from its verb with clauses. Someone
reading at eleven years old should follow it the first time through, because your reader
is scanning between meetings and a sentence they go back over has already lost.

CRAMPED, and both of these shipped:
  "The regulatory commentary. DTCC tokenization, Treasury clearing, SEC crypto posture,
   shows where the thinking is."
A fragment, then a list, then a verb whose subject is three clauses back. By the time you
reach "shows" you have forgotten what is doing the showing.

CLEAN, same facts, nothing lost:
  "Taffet publishes regulatory commentary regularly. Recent pieces covered DTCC
   tokenization, Treasury clearing and the SEC's crypto posture. That output shows where
   your thinking is."
Three sentences. Each one carries a single idea and every subject sits next to its verb.

CRAMPED:
  "Two new board seats in early 2026. Hollywood Food Coalition and Sovern LA, on top of
   running SCG full-time is a real load."
The same fault. An appositive list swallows the subject, so "is a real load" arrives with
nothing attached to it.

CLEAN:
  "You took two board seats in early 2026, at Hollywood Food Coalition and Sovern LA. That
   is on top of running SCG full time."
Two sentences. The naming sits inside a clean subject and verb rather than replacing one.

Note what did NOT change in either rewrite. Same facts, same specificity, same length
roughly. Only the joins moved.

EVERY SENTENCE MUST BE CLEAR ON ONE READING.

You are writing to someone scanning their inbox between meetings. A sentence they have to
go back over has already lost.

FAILING on clarity, and note this one is correctly pattern-framed, so getting the stance
right is not enough:
  "That tends to be when the next engagement goes uncontested to whoever stayed visible."
The idea is sound and the reader has to assemble it. Who is uncontested, what contest,
visible to whom. Say it plainly: "That is usually when the next piece of work goes to
whoever was still in front of them."

THE AIM TEST, run it on every draft. Read your observation, your bridge, the offer line
and your question as one message. If the reader could answer that question with "that is
not quite my problem", either the bridge aimed at the wrong gap or the question asks about
something the bridge never raised. Rewrite whichever is wrong.

Here is that failure, from real output:

AIMED WRONG:
  observation and bridge: "The weekly inbound you're fielding from people wanting to
   collaborate says the brand is working. The clients you actually want are a different
   current, and it doesn't run on the same word of mouth."
  the question it runs into: "Is getting more conversations in front of you something
   you're working on?"
The bridge says she already has plenty of conversations and the wrong ones. The question
asks whether she wants MORE. She does not want more. She wants different.

AIMED RIGHT, same observation, pattern-framed and pointed at what that question asks:
  "The weekly inbound you're fielding from people wanting to collaborate says the brand is
   working. Firms that build an audience that way often find it brings collaborators
   faster than it brings the clients they actually want."
Now she is short of the right conversations, which is what being asked about more
conversations answers. And it claims nothing about her results: it says what firms in her
position often find, not what is happening to her.

NEVER OPEN BY NAMING WHAT THEY LACK. No "there is no", no "nothing about", no "with no
case studies", no lists of what is missing from their site or their feed. A senior seller
does not tell a founder their website is thin. Notice something that IS there instead.

${FIRMOGRAPHIC_RULE_TEXT}

TWO MORE FAILURES WORTH KNOWING, both about who you are writing to:

FAILING:
  "Jason left Pani as Director of Product in July 2024 and launched HydrospherIQ three
   months later, with a current headcount of one."
Third person, about him rather than to him. A dossier entry. It leads nowhere.

FAILING:
  "You left Visteon at SVP level in December 2022. Knot Consulting has been the full focus
   since July 2023."
Second person and still wrong. It recites his own CV back at him. He knows all of it.

CONSTRAINTS, and there are only four:
  At most four sentences, at most ${OPENING_MAX_WORDS} words, for the observation, the
  bridge and the question together.
  Write to them, as "you" or by naming their company. Never write their first name in the
  text: the email already greets them by name on the line above.
  Use only what is in the findings below. Invent nothing, and do not soften a fact into
  something the findings do not support.
  Do not pitch and do not name the service. The offer line does that.

Return your answer as exactly two labelled blocks and nothing else:

OPENING: <the observation and the bridge>
QUESTION: <the closing question, ending in a question mark>`
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

// THE FLOOR, run on the personalised version ALONE, before any comparison.
//
// The comparison picks a winner, which means a flawed personalised email still ships
// whenever its template happens to be worse. Makesha's shipped claiming "the pipeline runs
// warm until the UK entity needs to feed it cold", asserting two things about her business
// nobody outside it could know. It beat its template and went out.
//
// So this runs first and can only disqualify. It is not a comparison and it has no
// opinion about quality: one question, about knowability.
export function buildFloorPrompt(): string {
  return `You are reviewing a cold email before it goes to a real person.

Does this email state something about the prospect's business that could not be known from
public information? Their pipeline, their diary, their results, whether their marketing
works.

Answer YES or NO, then one sentence.

YES means it claims private knowledge. NO means everything it asserts could be seen from
outside.

Reply in exactly this format:
CLAIMS_PRIVATE: NO
REASON: one sentence.`
}

/** The floor verdict on one attempt. Disqualifying, never comparative. */
export interface FloorCheck {
  claims_private: boolean
  reason: string
}

/**
 * Reads the floor verdict. An unreadable reply resolves to DISQUALIFIED, so ambiguity can
 * only ever fall back to the approved template.
 */
export function parseFloor(raw: string): FloorCheck {
  const m = raw.match(/CLAIMS_PRIVATE:\s*(YES|NO)/i)
  const r = raw.match(/REASON:\s*([\s\S]+)/i)
  const claims_private = m ? /yes/i.test(m[1]) : true
  return {
    claims_private,
    reason: (r?.[1] ?? raw).trim().split('\n')[0].trim() || 'No reasoning returned.',
  }
}

export function buildJudgePrompt(): string {
  return `You are the head of sales. Two drafts of the same cold email are in front of you,
both written by your team, both ready to send. They differ only in how they open.

Both go out under your name. Which one could a busy founder read once, at speed, without
going back over the first paragraph, and still find the closing question the obvious thing
to ask them?

Answer A or B, then one sentence on why.

Reply in exactly this format:
CHOICE: A
REASON: one sentence.`
}

/** The two drafts, labelled and ordered for one comparison. */
export interface JudgeComparison {
  /** The opening the writer produced for this round. */
  opening: string
  /** The closing question the writer produced for this round. */
  question: string
  /** The floor verdict on this attempt, run before the comparison. */
  floor: FloorCheck
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
  /**
   * Builds the complete Email 1. `question` is optional so the TEMPLATE side of the
   * comparison keeps its own approved CTA: both emails must be complete and genuinely
   * sendable, or the comparison is not honest.
   */
  composeEmail1: (opening: string, question?: string | null) => string
  /** The variant's own approved opening, the version the written one has to beat. */
  templateOpening: string
  prospectId: string
}

/** Splits the writer's two labelled blocks. */
export function parseWriterOutput(raw: string): { opening: string; question: string } {
  const openMatch = raw.match(/OPENING:\s*([\s\S]*?)(?=\n\s*QUESTION:|$)/i)
  const qMatch = raw.match(/QUESTION:\s*([\s\S]+)/i)
  const opening = cleanOpening(openMatch?.[1] ?? raw)
  const question = cleanOpening(qMatch?.[1] ?? '').split('\n')[0].trim()
  return { opening, question }
}

export async function writeAndJudgeOpening(params: WriteAndJudgeParams): Promise<OpeningResult> {
  const client = new Anthropic({ apiKey: params.apiKey })
  const findings = buildFindingsBlock(params.candidates)
  const writerSystem = buildWriterPrompt({ clientName: params.clientName, p3: params.p3, cta: params.cta })
  const judgeSystem = buildJudgePrompt()
  const floorSystem = buildFloorPrompt()

  // The template keeps its OWN approved CTA. Passing no question is what makes that true.
  const templateEmail = params.composeEmail1(params.templateOpening, null)

  const writeOnce = async (feedback: string | null): Promise<{ opening: string; question: string; gates: string[] }> => {
    const user = feedback
      ? `## Findings\n\n${findings}\n\n## Your previous attempt did not ship\n\nYou wrote:\n${feedback.split('|||')[0]}\n\nThe reason:\n${feedback.split('|||')[1]}\n\nWrite a different version that answers that. Return ONLY the two labelled blocks.`
      : `## Findings\n\n${findings}\n\nWrite the observation, the bridge and the closing question. Return ONLY the two labelled blocks.`
    const raw = await callModel(client, WRITER_MODEL, writerSystem, user, 700, `writer for prospect ${params.prospectId}`)
    const parsed = parseWriterOutput(raw)
    const opening = scrubAITells(parsed.opening, `research/writer/${params.prospectId}`)
    const question = scrubAITells(parsed.question, `research/writer/${params.prospectId}`)

    // The cap covers the whole written block, so gate the combined text.
    const gates = checkOpeningGates(`${opening} ${question}`.trim(), params.prospectFirstName, findings)
    if (!question) gates.push('writer returned no closing question')
    return { opening, question, gates }
  }

  // THE FLOOR. Runs on the personalised email alone, before any comparison, and can only
  // disqualify. A comparison picks a winner, so without this a flawed personalised email
  // ships whenever its template happens to be worse.
  const floorCheck = async (opening: string, question: string): Promise<FloorCheck> => {
    const email = params.composeEmail1(opening, question)
    const raw = await callModel(client, JUDGE_MODEL, floorSystem, email, 300, `floor for prospect ${params.prospectId}`)
    return parseFloor(raw)
  }

  const compare = async (opening: string, question: string, floor: FloorCheck): Promise<JudgeComparison> => {
    const writtenEmail = params.composeEmail1(opening, question)
    const writtenLabel: 'A' | 'B' = Math.random() < 0.5 ? 'A' : 'B'
    const emailA = writtenLabel === 'A' ? writtenEmail : templateEmail
    const emailB = writtenLabel === 'A' ? templateEmail : writtenEmail

    const user = `VERSION A\n\n${emailA}\n\n${'='.repeat(60)}\n\nVERSION B\n\n${emailB}`
    const raw = await callModel(client, JUDGE_MODEL, judgeSystem, user, 300, `judge for prospect ${params.prospectId}`)
    const { chosen, written_won, reason } = parseChoice(raw, writtenLabel)
    return { opening, question, floor, written_label: writtenLabel, chosen_label: chosen, written_won, reason }
  }

  const comparisons: JudgeComparison[] = []

  // A SECOND RETRY, BUT ONLY WHERE THE MATERIAL DESERVES IT.
  //
  // Debra and Udo both had findings that scored well and lost on execution, then fell back
  // to template with good material unused. Retrying a prospect whose findings are thin
  // just spends calls to arrive at the same place, so the extra attempt is bought by the
  // evidence: at least one candidate that passed all six tests.
  const strongMaterial = params.candidates.some(c => c.passes_all)
  const maxAttempts = strongMaterial ? 3 : 2

  type Attempt =
    | { kind: 'gated'; gates: string[]; opening: string; question: string }
    | { kind: 'floored'; floor: FloorCheck; opening: string; question: string }
    | { kind: 'compared'; c: JudgeComparison }

  const attempt = async (feedback: string | null): Promise<Attempt> => {
    const w = await writeOnce(feedback)
    if (w.gates.length > 0) return { kind: 'gated', gates: w.gates, opening: w.opening, question: w.question }

    const floor = await floorCheck(w.opening, w.question)
    if (floor.claims_private) {
      logger.warn('research/write-opening: floor disqualified the personalised version', {
        prospect_id: params.prospectId, reason: floor.reason,
      })
      return { kind: 'floored', floor, opening: w.opening, question: w.question }
    }
    return { kind: 'compared', c: await compare(w.opening, w.question, floor) }
  }

  const feedbackFrom = (a: Attempt): string =>
    a.kind === 'gated'
      ? `${a.opening} ${a.question}|||${a.gates.join('; ')}`
      : a.kind === 'floored'
        ? `${a.opening} ${a.question}|||A reviewer said this claims private knowledge about the prospect: ${a.floor.reason}. Say only what can be seen from outside.`
        : `${a.c.opening} ${a.c.question}|||${a.c.reason}`

  let feedback: string | null = null
  let last: Attempt | null = null

  for (let i = 0; i < maxAttempts; i++) {
    const a = await attempt(feedback)
    last = a

    if (a.kind === 'compared') {
      comparisons.push(a.c)
      if (a.c.written_won) {
        return {
          opening: a.c.opening, question: a.c.question, written_won: true,
          retry_used: i > 0, retries_used: i, strong_material: strongMaterial,
          comparisons, judge_reasoning: a.c.reason, gate_failures: [],
        }
      }
    }
    feedback = feedbackFrom(a)
  }

  // Every attempt used. The approved template ships, which is the correct outcome.
  const retries = maxAttempts - 1
  const reason =
    last?.kind === 'gated'
      ? `Failed deterministic gates on the final attempt: ${last.gates.join('; ')}`
      : last?.kind === 'floored'
        ? `Disqualified by the floor on the final attempt: ${last.floor.reason}`
        : last?.kind === 'compared'
          ? last.c.reason
          : 'No attempt completed.'

  return {
    opening: null, question: null, written_won: false,
    retry_used: retries > 0, retries_used: retries, strong_material: strongMaterial,
    comparisons, judge_reasoning: reason,
    gate_failures: last?.kind === 'gated' ? last.gates : [],
  }
}
