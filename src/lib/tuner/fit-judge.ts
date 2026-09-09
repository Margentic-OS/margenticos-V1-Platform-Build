// Judging a researched company against the client's own document.
//
// ─── FOUR ANSWERS, NOT TWO, AND WHY THE MIDDLE ONE IS LOAD-BEARING ───────────
//
// A client's document describes more than one kind of customer: a best kind and an
// acceptable kind. A two-answer judge has to put the acceptable kind somewhere, and wherever
// it puts them is wrong. Counted as a pass, a search that finds only second-choice buyers
// scores like one that finds first-choice buyers. Counted as a fail, the loop is rewarded for
// cutting real customers out of the search.
//
// So the answers are: best, acceptable, neither, and could-not-establish. All four are
// counted and reported on every round. A candidate search that raises the best-fit share
// while cutting the acceptable-fit COUNT is a trade, and the loop reports it as a trade
// rather than as an improvement.
//
// ─── UNRESOLVED IS NEVER A PASS ──────────────────────────────────────────────
//
// Measured on real samples, 15% to 40% of rows could not be established even with every
// company researched. That is the normal condition here, not an edge case. An unresolved row
// counts towards the denominator of the all-rows proportion and towards neither numerator,
// and a round where most rows stay unresolved reports low signal rather than a number.
//
// ─── RULE ZERO ───────────────────────────────────────────────────────────────
//
// The prompt below names no industry, sector, product, country, buyer type, job title or
// company. What the client sells, and what its best and acceptable customers look like,
// arrive at run time from that client's own documents. buildFitJudgePrompt is registered in
// prompt-sources.ts and the forbidden-content scan reads the exact string that is sent.

import Anthropic from '@anthropic-ai/sdk'
import { logger } from '@/lib/logger'
import type { SampleRow } from '@/lib/tuner/count-and-sample'

const FIT_JUDGE_MODEL = 'claude-sonnet-4-6'

/** Explicit, because the SDK defaults are 10 minutes and 2 retries. */
const FIT_JUDGE_TIMEOUT_MS = 120_000
const FIT_JUDGE_MAX_RETRIES = 1
const FIT_JUDGE_MAX_TOKENS = 8192

/** Rows per model call. A sample of 80 is judged in batches rather than one enormous message. */
export const JUDGE_BATCH = 40

export type FitVerdict = 'best' | 'acceptable' | 'neither' | 'cannot_establish'

export interface JudgedCompany {
  sourceId: string
  jobTitle: string | null
  companyName: string | null
  verdict: FitVerdict
  reason: string
  /** What the research read, stored so a human can disagree with the verdict. */
  researchText: string | null
  billableSearches: number
}

/** The client's own words. Never a description written in this file. */
export interface FitContext {
  sells: string
  usedFor: string
  /** How the document describes its best customer. */
  bestDescription: string
  /** How the document describes an acceptable customer. */
  acceptableDescription: string
}

export function buildFitJudgePrompt(context: FitContext): string {
  return `You are checking whether organisations found by a search could buy from one business, using a researched description of each organisation.

WHAT THE BUSINESS SELLS, in its own words:
${context.sells}

WHAT IT IS USED FOR, in its own words:
${context.usedFor}

ITS BEST KIND OF CUSTOMER, in its own words:
${context.bestDescription}

A CUSTOMER IT WOULD STILL ACCEPT, in its own words:
${context.acceptableDescription}

WHAT YOU ARE GIVEN

For each organisation: a job title, the employer name, and a researched description of what that employer does. The description may be thin, absent, or about a different organisation with a similar name.

THE FOUR ANSWERS

"best"              the researched description shows this organisation matches the best kind of customer described above.
"acceptable"        it does not match the best kind, but it does match the kind the business would still accept. These are real customers. Do not push them into "neither" because they are second choice.
"neither"           the description shows positively that this organisation is not a customer of either kind.
"cannot_establish"  the description does not settle it, or there was none, or you cannot tell whether it describes the right organisation.

"cannot_establish" is a correct answer and it is common. Most organisation names describe nothing, and a thin description does not become knowledge by being read carefully. Answering it costs nothing. Guessing costs the whole measurement, because a guessed answer is counted as if it were established.

Do not reason from what is statistically common. Do not treat an unfamiliar organisation as unsuitable. Decide from the researched description and the two customer descriptions above, and from nothing else.

OUTPUT

Return only JSON:

{"verdicts":[{"id":"the id given","verdict":"best" | "acceptable" | "neither" | "cannot_establish","reason":"one short sentence naming what decided it"}]}`
}

export type FitJudgeFn = (
  rows: (SampleRow & { researchText: string | null })[],
  context: FitContext,
) => Promise<{ verdicts: { sourceId: string; verdict: FitVerdict; reason: string }[]; modelCalls: number }>

function renderRows(rows: (SampleRow & { researchText: string | null })[]): string {
  return rows.map(r =>
    `id: ${r.sourceId}\n  job title: ${r.jobTitle ?? '(none given)'}\n  employer: ${r.companyName ?? '(none given)'}\n  researched: ${r.researchText ?? '(nothing usable was found)'}`,
  ).join('\n\n')
}

const VERDICTS: readonly FitVerdict[] = ['best', 'acceptable', 'neither', 'cannot_establish']

export const anthropicFitJudge: FitJudgeFn = async (rows, context) => {
  if (rows.length === 0) return { verdicts: [], modelCalls: 0 }

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: FIT_JUDGE_TIMEOUT_MS,
    maxRetries: FIT_JUDGE_MAX_RETRIES,
  })

  const byId = new Map<string, { sourceId: string; verdict: FitVerdict; reason: string }>()
  let modelCalls = 0

  for (let i = 0; i < rows.length; i += JUDGE_BATCH) {
    const batch = rows.slice(i, i + JUDGE_BATCH)
    const response = await client.messages.create({
      model: FIT_JUDGE_MODEL,
      max_tokens: FIT_JUDGE_MAX_TOKENS,
      system: buildFitJudgePrompt(context),
      messages: [{ role: 'user', content: renderRows(batch) }],
    })
    modelCalls += 1
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text).join('')
    for (const v of parseFitVerdicts(text)) byId.set(v.sourceId, v)
  }

  // A row the judge did not answer for becomes cannot_establish, never a dropped row.
  // Dropping it would shrink the denominator and make a judge that answers fewer rows look
  // better the more it fails to answer.
  return {
    verdicts: rows.map(r => byId.get(r.sourceId) ?? {
      sourceId: r.sourceId, verdict: 'cannot_establish' as const,
      reason: 'The judge returned no answer for this row.',
    }),
    modelCalls,
  }
}

export function parseFitVerdicts(raw: string): { sourceId: string; verdict: FitVerdict; reason: string }[] {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1) return []
  let parsed: { verdicts?: unknown }
  try { parsed = JSON.parse(raw.slice(start, end + 1)) as { verdicts?: unknown } } catch { return [] }
  if (!Array.isArray(parsed.verdicts)) return []
  const out: { sourceId: string; verdict: FitVerdict; reason: string }[] = []
  for (const e of parsed.verdicts as Record<string, unknown>[]) {
    const id = typeof e?.id === 'string' ? e.id : ''
    const verdict = e?.verdict
    if (!id || typeof verdict !== 'string') continue
    if (!VERDICTS.includes(verdict as FitVerdict)) continue
    out.push({ sourceId: id, verdict: verdict as FitVerdict, reason: typeof e.reason === 'string' ? e.reason : '' })
  }
  return out
}

// ─── The two proportions, never collapsed ────────────────────────────────────

export interface FitOutcome {
  sampled: number
  best: number
  acceptable: number
  neither: number
  cannotEstablish: number
  /** Fits out of EVERYONE sampled. Moves with the research success rate as well as with quality. */
  fitOfAll: number | null
  /** Fits out of those that could be established. The one to compare rounds on. */
  fitOfResolved: number | null
  resolved: number
  /** True when too little was established for either figure to mean anything. */
  lowSignal: boolean
  note: string
}

/**
 * Above this share unresolved, the round reports low signal and falls back to the numbers.
 *
 * JUDGEMENT, informed by measurement: real samples ran 15% to 40% unresolved, so a threshold
 * below about half would fire on ordinary rounds and teach an operator to ignore it.
 */
export const LOW_SIGNAL_UNRESOLVED_SHARE = 0.5

/**
 * The fewest resolved rows the loop will report a proportion on.
 *
 * Measured: at a sample of 20 roughly 14 rows resolve, and a proportion on 14 rows has a
 * standard error near 13 points, which is the same size as the effects being looked for.
 */
export const MIN_RESOLVED_FOR_A_FIGURE = 25

export function assessFit(judged: JudgedCompany[]): FitOutcome {
  const best = judged.filter(j => j.verdict === 'best').length
  const acceptable = judged.filter(j => j.verdict === 'acceptable').length
  const neither = judged.filter(j => j.verdict === 'neither').length
  const cannotEstablish = judged.filter(j => j.verdict === 'cannot_establish').length
  const sampled = judged.length
  const resolved = best + acceptable + neither
  const fits = best + acceptable

  const lowSignal = sampled > 0 && cannotEstablish / sampled > LOW_SIGNAL_UNRESOLVED_SHARE
  const enough = resolved >= MIN_RESOLVED_FOR_A_FIGURE

  return {
    sampled, best, acceptable, neither, cannotEstablish, resolved,
    // BOTH, ALWAYS. Null is "not measured", never zero: a caller reading 0 would conclude
    // nothing fitted, which is the opposite of "we could not tell".
    fitOfAll: enough && sampled > 0 ? fits / sampled : null,
    fitOfResolved: enough ? fits / resolved : null,
    lowSignal,
    note: !enough
      ? `No proportion reported: ${resolved} of ${sampled} rows resolved, ${MIN_RESOLVED_FOR_A_FIGURE} needed. ` +
        `A rate on this many moves by tens of points on a single row.`
      : `${best} best, ${acceptable} acceptable, ${neither} neither, ${cannotEstablish} could not be established ` +
        `of ${sampled}. Fit of all sampled ${((fits / sampled) * 100).toFixed(1)}%; fit of those established ` +
        `${((fits / resolved) * 100).toFixed(1)}%.`,
  }
}

/**
 * The smallest fit difference that is a difference.
 *
 * ─── DERIVED FROM MEASUREMENT AT THE SAMPLE SIZE ACTUALLY USED ───────────────
 *
 * Three draws of 80 rows from ONE UNCHANGED search, every company researched and judged:
 *
 *   fit of all sampled     52.5%, 27.5%, 43.8%   mean 41.3%   sd 10.4 points
 *   fit of those resolved  61.8%, 45.8%, 59.3%   mean 55.6%   sd  7.0 points
 *
 * The resolved figure is markedly steadier, because the all-rows figure carries the research
 * success rate as well as the search quality, and that rate swung from 15% to 40% unresolved
 * between identical draws.
 *
 * So comparisons are made on the resolved figure. Its standard error between two independent
 * draws is about sqrt(2) x 7.0 = 9.9 points, and the theoretical binomial figure at 68
 * resolved rows and p = 0.556 is 8.5 points, which agree. Fifteen points is roughly one and a
 * half of those, which is the point at which a difference is worth acting on rather than
 * worth noticing.
 *
 * THE LIMITATION, stated rather than buried: three draws is a thin basis for a standard
 * deviation, and this figure should be re-measured once real rounds have accumulated. The
 * measured floor is stored on every run so that can be done from the record.
 */
export const MIN_FIT_IMPROVEMENT = 0.15

export interface FitComparison {
  before: number | null
  after: number | null
  delta: number | null
  /** True only when the change exceeds the measured noise floor. */
  isRealChange: boolean
  /** True when best-fit share rose while the acceptable COUNT fell. Reported as a trade. */
  isTrade: boolean
  note: string
}

export function compareFit(before: FitOutcome, after: FitOutcome): FitComparison {
  const a = before.fitOfResolved
  const b = after.fitOfResolved
  if (a === null || b === null) {
    return {
      before: a, after: b, delta: null, isRealChange: false, isTrade: false,
      note: 'No comparison: one of the two rounds resolved too few rows to report a proportion.',
    }
  }
  const delta = b - a
  const real = Math.abs(delta) >= MIN_FIT_IMPROVEMENT

  // THE TRADE. Best-fit share up while the acceptable COUNT is down means the search got
  // choosier by dropping real customers. That is a decision for a person, not an improvement.
  const beforeBestShare = before.resolved > 0 ? before.best / before.resolved : 0
  const afterBestShare = after.resolved > 0 ? after.best / after.resolved : 0
  const isTrade = afterBestShare > beforeBestShare && after.acceptable < before.acceptable

  return {
    before: a, after: b, delta, isRealChange: real, isTrade,
    note: isTrade
      ? `TRADE, not an improvement: the best-fit share rose from ${(beforeBestShare * 100).toFixed(1)}% to ` +
        `${(afterBestShare * 100).toFixed(1)}% while acceptable customers fell from ${before.acceptable} to ` +
        `${after.acceptable}. Those are real customers being cut out. A person decides this.`
      : real
        ? `Fit of resolved moved ${(delta * 100).toFixed(1)} points, past the ${(MIN_FIT_IMPROVEMENT * 100).toFixed(0)}-point measured noise floor.`
        : `Fit of resolved moved ${(delta * 100).toFixed(1)} points, inside the ${(MIN_FIT_IMPROVEMENT * 100).toFixed(0)}-point measured noise floor. ` +
          'This is no change: three draws from one unchanged search varied by this much on their own.',
  }
}

export function logFitRound(outcome: FitOutcome): void {
  logger.info('tuner: fit round', {
    sampled: outcome.sampled,
    best: outcome.best,
    acceptable: outcome.acceptable,
    neither: outcome.neither,
    cannot_establish: outcome.cannotEstablish,
    fit_of_all: outcome.fitOfAll,
    fit_of_resolved: outcome.fitOfResolved,
    low_signal: outcome.lowSignal,
  })
}
