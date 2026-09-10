// Judging a company from its employer name, and MEASURING whether that was worth doing.
//
// ─── THIS IS A MEASURING INSTRUMENT BEFORE IT IS A COST SAVING ───────────────
//
// The moment a name-derived verdict is counted alongside a researched one, the number that
// comes out is measuring OUR ASSUMPTIONS ABOUT NAMES rather than measuring the search. The
// two are therefore never added together. Every round reports two figures: one among
// researched rows only, and one including the name-decided rows. There is no single number,
// deliberately, because a single number is exactly the thing that would hide this.
//
// Keeping them apart is what lets the loop TELL US whether names are trustworthy for a given
// client, instead of us assuming it in either direction. When the two figures disagree by
// more than the judge's own run-to-run variation, the round says so and researches
// everything. That costs more than not gating at all, and it is the correct trade: the
// alternative is a cheaper number that is quietly wrong.
//
// ─── A NAME WITH NO CLEAR SIGNAL IS ALWAYS RESEARCHED ────────────────────────
//
// "unclear" is a first-class answer and it is expected to be the common one. It is not a
// failure to answer; it is the answer, and it costs one lookup.
//
// ─── RULE ZERO, AND IT IS SHARPEST HERE ──────────────────────────────────────
//
// NOTHING IN THIS FILE MAY SAY WHAT A NAME MEANS. No word, phrase, sector, product, buyer
// type or company name appears in the prompt, the code, the comments or the tests, and none
// may be added. The whole of the model's view comes from the four descriptions injected at
// run time, which are that client's own words out of that client's own document.
//
// The test of whether a line here is legitimate: the same employer name must be able to come
// back "best" for one client and "neither" for another, decided entirely by the descriptions
// passed in. Any rule written into this file that survives changing the client is a rule
// about names in general, and that is the violation.

import Anthropic from '@anthropic-ai/sdk'
import { logger } from '@/lib/logger'
import type { SampleRow } from '@/lib/tuner/count-and-sample'
import type { FitContext, FitOutcome, FitVerdict } from '@/lib/tuner/fit-judge'

/** The cheapest model available. Reading a name against four descriptions is simple work. */
const NAME_SIGNAL_MODEL = 'claude-haiku-4-5-20251001'
const NAME_SIGNAL_MAX_TOKENS = 4096
const NAME_SIGNAL_TIMEOUT_MS = 120_000
const NAME_SIGNAL_MAX_RETRIES = 1

/** Names per call. Matches the fit judge's batch so the two are read against each other. */
export const NAME_SIGNAL_BATCH = 40

/**
 * What a name can say.
 *
 * The three real verdicts are the fit judge's own, so the two are directly comparable, which
 * is the entire point: a comparison between differently-shaped answers would prove nothing.
 * `unclear` is this module's alone and means "research it", never "cannot_establish": those
 * are different facts and only one of them costs money to resolve.
 */
export type NameSignalAnswer = Extract<FitVerdict, 'best' | 'acceptable' | 'neither'> | 'unclear'

export interface NameSignalDecision {
  sourceId: string
  answer: NameSignalAnswer
  /** One short sentence, kept so a human can disagree with a row that was never researched. */
  reason: string
}

export type NameSignalFn = (
  rows: SampleRow[],
  context: FitContext,
) => Promise<{
  decisions: NameSignalDecision[]
  modelCalls: number
  usage?: { inputTokens: number; outputTokens: number; model: string | null }
}>

export function buildNameSignalPrompt(context: FitContext): string {
  return `You are looking at employer names. Nothing has been researched. For each name you say whether the name ITSELF is enough to place the organisation against the descriptions below, and most of the time it will not be.

WHAT THE BUSINESS SELLS, in its own words:
${context.sells}

WHAT IT IS USED FOR, in its own words:
${context.usedFor}

ITS BEST KIND OF CUSTOMER, in its own words:
${context.bestDescription}

A CUSTOMER IT WOULD STILL ACCEPT, in its own words:
${context.acceptableDescription}

WHAT YOU ARE GIVEN

An employer name, and nothing else. No description, no website, no research.

THE FOUR ANSWERS

"best"        the name itself states what the organisation does, and what it states places it in the best kind of customer described above.
"acceptable"  the name itself states what the organisation does, and what it states places it in the kind the business would still accept.
"neither"     the name itself states what the organisation does, and what it states is outside both descriptions above.
"unclear"     the name does not settle it. THIS IS THE COMMON ANSWER AND IT IS A CORRECT ONE.

"unclear" COSTS NOTHING AND IS ALWAYS AVAILABLE

A row answered "unclear" is researched properly before anything is decided about it. Nothing is lost by answering it, and it is the right answer whenever any of the following is true:

- The name does not state an activity at all.
- The name gestures at an activity without stating one.
- You are reasoning from what organisations with names of this shape are usually like.
- You are reasoning from size, age, prestige, or how well known it is.
- You are reasoning from anything you happen to know about this organisation rather than from the name in front of you.
- More than one organisation could hold this name.
- You would want to check before saying it aloud.

Do not stretch a name to reach one of the first three answers. A name that merely sounds compatible is "unclear". A name that merely sounds incompatible is "unclear".

WHAT DECIDES IT

Only the four descriptions above. They are one business's own words about itself and they change from one list to the next. The same name may belong in "best" against one set of descriptions and in "neither" against another, and that is correct. Do not carry any general view about what names of a given shape mean; there is no such view that survives changing the descriptions.

OUTPUT

Return only JSON:

{"decisions":[{"id":"the id given","answer":"best" | "acceptable" | "neither" | "unclear","reason":"one short sentence naming what in the name decided it"}]}`
}

function renderNames(rows: SampleRow[]): string {
  return rows.map(r =>
    `id: ${r.sourceId}\n  employer: ${r.companyName ?? '(none given)'}`,
  ).join('\n\n')
}

const DECIDING: readonly NameSignalAnswer[] = ['best', 'acceptable', 'neither']

/** True when this answer removes the row from the research set. */
export function isDecided(answer: NameSignalAnswer): boolean {
  return (DECIDING as readonly string[]).includes(answer)
}

/**
 * Read the model's answer.
 *
 * EXPORTED SO IT CAN BE TESTED ON ITS OWN. Anything not exactly one of the three deciding
 * strings becomes `unclear`, which means researched. Malformed JSON, a missing answer, an
 * invented verdict and a row the model skipped all land there. The failure direction is
 * always "we paid for a lookup we might not have needed", never "we decided a row we never
 * read and never checked".
 */
export function parseNameSignal(raw: string): NameSignalDecision[] {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1) return []

  let parsed: { decisions?: unknown }
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed.decisions)) return []

  const out: NameSignalDecision[] = []
  for (const d of parsed.decisions) {
    if (!d || typeof d !== 'object') continue
    const row = d as { id?: unknown; answer?: unknown; reason?: unknown }
    if (typeof row.id !== 'string' || !row.id) continue
    const answer = (DECIDING as readonly unknown[]).includes(row.answer)
      ? (row.answer as NameSignalAnswer)
      : 'unclear'
    out.push({
      sourceId: row.id,
      answer,
      reason: typeof row.reason === 'string' ? row.reason : '',
    })
  }
  return out
}

export const anthropicNameSignal: NameSignalFn = async (rows, context) => {
  if (rows.length === 0) {
    return { decisions: [], modelCalls: 0, usage: { inputTokens: 0, outputTokens: 0, model: null } }
  }

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: NAME_SIGNAL_TIMEOUT_MS,
    maxRetries: NAME_SIGNAL_MAX_RETRIES,
  })

  const byId = new Map<string, NameSignalDecision>()
  let modelCalls = 0
  let inputTokens = 0
  let outputTokens = 0

  for (let i = 0; i < rows.length; i += NAME_SIGNAL_BATCH) {
    const batch = rows.slice(i, i + NAME_SIGNAL_BATCH)
    const response = await client.messages.create({
      model: NAME_SIGNAL_MODEL,
      max_tokens: NAME_SIGNAL_MAX_TOKENS,
      system: buildNameSignalPrompt(context),
      messages: [{ role: 'user', content: renderNames(batch) }],
    })
    modelCalls += 1
    inputTokens += response.usage?.input_tokens ?? 0
    outputTokens += response.usage?.output_tokens ?? 0
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text).join('')
    for (const d of parseNameSignal(text)) byId.set(d.sourceId, d)
  }

  // A ROW THE MODEL DID NOT ANSWER FOR IS RESEARCHED, never decided.
  return {
    decisions: rows.map(r => byId.get(r.sourceId) ?? {
      sourceId: r.sourceId, answer: 'unclear' as const,
      reason: 'No answer was returned for this row, so it is researched as normal.',
    }),
    modelCalls,
    usage: { inputTokens, outputTokens, model: NAME_SIGNAL_MODEL },
  }
}

/**
 * Whether the name-decided rows agree with the researched ones, and what to do about it.
 *
 * ─── WHY THE COMPARISON IS ON fitOfResolved AND NOT ON fitOfAll ──────────────
 *
 * fitOfAll divides by every row sampled, including the ones nothing could settle. A
 * name-decided row is settled by construction: the three deciding answers are all verdicts,
 * and none of them is cannot_establish. So ADDING name-decided rows raises the settled share
 * mechanically, whether or not the names were any good, and a check on fitOfAll would fire
 * on that arithmetic rather than on disagreement. It would be a check that trips when the
 * gate does anything at all.
 *
 * fitOfResolved is a RATE among settled rows on both sides. If names carry real signal for
 * this client, the rate among name-decided rows sits where the rate among researched rows
 * sits, and the two figures agree. If names carry no signal, the name-decided rows are
 * effectively arbitrary and pull the combined rate away from the measured one. That is the
 * difference this looks at.
 *
 * BOTH FIGURES ARE STILL REPORTED IN FULL, both proportions of each. This function chooses
 * what to ACT on; it does not choose what to show.
 *
 * ─── AND WHY THE FLOOR IS MEASURED PER ROUND, NOT TAKEN FROM MIN_FIT_IMPROVEMENT ──
 *
 * The first version of this check used MIN_FIT_IMPROVEMENT, the tuner's 19-point noise floor.
 * THAT WAS THE WRONG INSTRUMENT and it passed both live clients when it should have failed
 * both.
 *
 * 19 points is a DRAW-TO-DRAW figure: it was measured by drawing four different samples of
 * eighty from one unchanged search, so it contains sampling noise, which is most of it. This
 * comparison involves no sampling at all. It is the same rows, split into those a name
 * decided and those research decided. The only variation that belongs in the floor is the
 * judge's own, on identical input.
 *
 * MEASURED 2026-09-09, re-judging the same eighty rows a second time:
 *
 *   client 1   judge moved 1 of 80 verdicts,  0.2 points   names shifted the figure  9.6 points
 *   client 2   judge moved 4 of 80 verdicts,  3.3 points   names shifted the figure 16.2 points
 *
 * Against 19 both passed. Against the judge's actual variation both fail by a wide margin,
 * and in the same direction on both clients: the names are roughly twice as generous as the
 * research, 20.5% against 10.9% and 34.2% against 17.9%. That is exactly the failure the
 * separation exists to catch, and the loose floor was hiding it.
 *
 * So the floor is now measured in the round that uses it, by judging the researched rows
 * twice. That costs one extra call on the judging model per round, which is a few percent of
 * a round, and it is the difference between a check and a formality.
 */
export interface NameSignalVerdict {
  /** False when the two figures disagree by more than the judge's own variation. */
  reliable: boolean
  /** Null when there was nothing to compare: no name-decided rows, or no resolved rows. */
  differenceOnResolved: number | null
  noiseFloor: number
  reason: string
}

/**
 * The smallest difference worth calling a difference, whatever the judge did.
 *
 * A re-run that happens to return identical verdicts gives a measured variation of exactly
 * zero, and a floor of zero fails every round including the honest ones. One verdict flipping
 * is the finest change the figure can express, so that is the floor's own floor.
 */
export function oneVerdictWorth(resolved: number): number {
  return resolved > 0 ? 1 / resolved : 1
}

export function checkNameSignal(
  researchedOnly: FitOutcome,
  includingNames: FitOutcome,
  decidedCount: number,
  noiseFloor: number,
): NameSignalVerdict {
  if (decidedCount === 0) {
    return {
      reliable: true, differenceOnResolved: null, noiseFloor,
      reason: 'No row was decided from its name, so there is nothing to disagree with. Every ' +
        'row in this round was researched.',
    }
  }
  const a = researchedOnly.fitOfResolved
  const b = includingNames.fitOfResolved
  if (a === null || b === null) {
    // NOT "reliable". A comparison that could not be made has not passed; it has not run.
    // Treating an absent measurement as a pass is the shape this whole module exists to
    // avoid, so the absent case falls back too.
    return {
      reliable: false, differenceOnResolved: null, noiseFloor,
      reason: 'Too few rows were settled to compute a rate on one side or both, so the two ' +
        'figures could not be compared. An unmeasured agreement is not an agreement, so this ' +
        'round researches everything rather than trusting the names.',
    }
  }
  const difference = Math.abs(a - b)
  if (difference > noiseFloor) {
    return {
      reliable: false, differenceOnResolved: difference, noiseFloor,
      reason:
        `NAME SIGNAL IS UNRELIABLE FOR THIS CLIENT. Among researched rows the fit rate is ` +
        `${(a * 100).toFixed(1)}%; including the ${decidedCount} name-decided rows it is ` +
        `${(b * 100).toFixed(1)}%. That is ${(difference * 100).toFixed(1)} points, against a ` +
        `judge that moves ${(noiseFloor * 100).toFixed(1)} points on identical input. The ` +
        'names are saying something the research does not support, so this round falls back ' +
        'to researching everything and the saving is given up.',
    }
  }
  return {
    reliable: true, differenceOnResolved: difference, noiseFloor,
    reason:
      `Among researched rows the fit rate is ${(a * 100).toFixed(1)}%; including the ` +
      `${decidedCount} name-decided rows it is ${(b * 100).toFixed(1)}%. That is ` +
      `${(difference * 100).toFixed(1)} points, inside the ${(noiseFloor * 100).toFixed(1)} ` +
      'points the judge moves on identical input, so the names did not shift the picture.',
  }
}

export function logNameSignal(
  total: number, decided: number, verdict: NameSignalVerdict,
): void {
  logger.info('tuner: name signal', {
    names_seen: total,
    name_decided: decided,
    researched: total - decided,
    share_decided: total ? decided / total : 0,
    reliable: verdict.reliable,
    difference_on_resolved: verdict.differenceOnResolved,
    noise_floor: verdict.noiseFloor,
  })
}
