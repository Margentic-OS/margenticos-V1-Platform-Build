// The judge: does this row look like somebody the client could sell to?
//
// ─── WHAT IT IS ALLOWED TO SEE, AND WHY THE QUESTION IS SHAPED AROUND THAT ───
//
// MEASURED AGAINST THE PROVIDER 2026-09-08. A search response row carries exactly three
// values: a first name, a job title, and an employer name. Everything else in the response
// is a boolean presence flag — whether the employer HAS an industry, a revenue, an employee
// count — never what any of them is.
//
// So the judge is asked a question answerable from a job title and an employer name, and
// nothing else. It is not asked whether the company is the right size, or in the right
// place, or in the right sector, because none of those is knowable from what it is shown,
// and a judge asked an unanswerable question does not abstain, it guesses.
//
// ─── WHY THREE VERDICTS AND NOT TWO ──────────────────────────────────────────
//
// Most employer names carry no information about what the business does. A two-verdict
// judge has to put those somewhere, and wherever it puts them is a lie: as "fits" it
// approves an unknown, as "does not fit" it rejects a company for having an uninformative
// name. The third verdict is the honest answer and it is also the useful one, because it is
// the only signal that tells the loop a lookup would help.
//
// A round where most answers stay "cannot tell" after lookups is reported as LOW NAME
// SIGNAL and the loop falls back to numbers. That is a correct outcome. The names in that
// client's market do not describe the businesses, and no amount of judging will change it.
//
// ─── RULE ZERO ───────────────────────────────────────────────────────────────
//
// The prompt below names no industry, sector, product, country, buyer type or company. What
// the client sells arrives at run time, in the client's own words, from the client's own
// documents. The prompt states the question at category level only. This is scanned:
// buildJudgePrompt is registered in prompt-sources.ts and the forbidden-content test reads
// the exact string sent.

import Anthropic from '@anthropic-ai/sdk'
import { logger } from '@/lib/logger'
import type { JudgeVerdict, JudgedRow } from '@/lib/tuner/types'
import type { SampleRow } from '@/lib/tuner/count-and-sample'

const JUDGE_MODEL = 'claude-sonnet-4-6'

/**
 * EXPLICIT, because the SDK defaults are 10 minutes and 2 retries.
 *
 * Inheriting them puts a worst case of 30 minutes inside a route whose ceiling is 300
 * seconds, which does not fail cleanly: the platform kills the request and the run leaves
 * no terminal state at all. Every model call in the tuner sets both.
 *
 * 45 seconds is chosen against measurement: the document-reading agent, on a materially
 * larger prompt, completed in 16.5 to 19.3 seconds across three runs. One retry, not two,
 * because a bounded round has room for one recovery and not for two.
 */
const JUDGE_TIMEOUT_MS = 45_000
const JUDGE_MAX_RETRIES = 1
const JUDGE_MAX_TOKENS = 4096

/**
 * The fewest resolved answers the tuner will report an agreement figure on.
 *
 * FOLLOWS THE EXISTING SANITY BAND, which refuses to report an accept rate below 25 distinct
 * sourced titles and says so rather than returning a number. The reason is the same here and
 * it is worth stating: on a handful of answers a one-item difference moves the rate by tens
 * of percent, so a figure computed there is noise presented as a finding, and a fixed pass
 * mark applied to it is worse than no check.
 *
 * RESOLVED, not sampled. A "cannot tell" is not an answer about the population, so twenty
 * rows of which three resolved is a sample of three.
 */
export const MIN_RESOLVED_SAMPLE = 12

/** What the client sells, in the client's own words. Never a sector label written here. */
export interface ClientContext {
  /** One or two sentences from the client's own documents. */
  sells: string
  /** What it is used for, and by whom, in the client's own words. */
  usedFor: string
}

export interface JudgeRequest {
  rows: SampleRow[]
  context: ClientContext
}

/**
 * A judge, as a function, so the tests can supply their own.
 *
 * THE NEGATIVE CONTROLS DEPEND ON THIS BEING INJECTABLE. Proving that an always-approving
 * judge is caught requires supplying one, and a module that constructs its own Anthropic
 * client inside the scoring function cannot be given one.
 */
export type JudgeFn = (req: JudgeRequest) => Promise<{ verdicts: RawVerdict[]; modelCalls: number }>

export interface RawVerdict {
  sourceId: string
  verdict: JudgeVerdict
  reason: string
}

// ─── The prompt ──────────────────────────────────────────────────────────────
//
// EXPORTED as a builder so the scan reads the exact text that is sent, not a copy of it.

export function buildJudgePrompt(context: ClientContext): string {
  return `You are checking whether people found by a search could plausibly be buyers for one business.

WHAT THAT BUSINESS SELLS, in its own words:
${context.sells}

WHAT IT IS USED FOR, in its own words:
${context.usedFor}

WHAT YOU ARE GIVEN

For each person you get two things and nothing else: their job title, and the name of the organisation that employs them. You do not get what the organisation does, how large it is, where it is, or anything else. Do not assume any of those. Do not infer a size or a location from a name.

THE QUESTION

For each person, answer this one question: does the pair of job title and employer name give positive reason to believe this organisation could be a buyer for what is described above?

Answer "fits" only when the employer name itself carries a meaning that matches what the business above sells into, or the job title is one that would own this problem in an organisation of the kind described. You must be able to say what in the two strings made you answer.

Answer "does_not_fit" when the name or the title carries a meaning that is positively inconsistent with what is described above. Not merely unfamiliar. Inconsistent.

Answer "cannot_tell" whenever the two strings do not settle it. This is the correct answer for most organisation names, because most names are invented words, personal names, initials or abbreviations that describe nothing. Answering "cannot_tell" is not a failure and it is not a weak answer. Guessing from a name that carries no meaning is the failure.

WHAT NOT TO DO

Do not reason from what is statistically common. Do not treat an unfamiliar name as evidence either way. Do not let the job title alone carry a verdict when the employer is unknown, unless that title could only exist in the kind of organisation described above. If you find yourself constructing a story about what an organisation probably does, the answer is "cannot_tell".

OUTPUT

Return only JSON, no prose around it:

{"verdicts":[{"id":"the id given","verdict":"fits" | "does_not_fit" | "cannot_tell","reason":"one short sentence naming what in the two strings decided it"}]}`
}

/** Render the rows for the model. Ids only, so nothing is matched by position. */
function renderRows(rows: SampleRow[]): string {
  return rows
    .map(r => `id: ${r.sourceId}\n  job title: ${r.jobTitle ?? '(none given)'}\n  employer: ${r.companyName ?? '(none given)'}`)
    .join('\n\n')
}

/** The real judge. One model call per batch of rows. */
export const anthropicJudge: JudgeFn = async ({ rows, context }) => {
  if (rows.length === 0) return { verdicts: [], modelCalls: 0 }

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: JUDGE_TIMEOUT_MS,
    maxRetries: JUDGE_MAX_RETRIES,
  })

  const response = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: JUDGE_MAX_TOKENS,
    system: buildJudgePrompt(context),
    messages: [{ role: 'user', content: renderRows(rows) }],
  })

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('')

  return { verdicts: parseVerdicts(text, rows), modelCalls: 1 }
}

/**
 * Parse the model's answer.
 *
 * A ROW THE MODEL DID NOT ANSWER FOR BECOMES "cannot_tell", NOT A DROPPED ROW. Dropping it
 * would shrink the denominator of the agreement figure and make an unreliable judge look
 * better the more rows it failed to answer, which is the wrong direction for every incentive
 * in this module.
 */
export function parseVerdicts(raw: string, rows: SampleRow[]): RawVerdict[] {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  let parsed: { verdicts?: unknown } = {}
  if (start !== -1 && end !== -1) {
    try { parsed = JSON.parse(raw.slice(start, end + 1)) as { verdicts?: unknown } } catch { parsed = {} }
  }

  const byId = new Map<string, RawVerdict>()
  if (Array.isArray(parsed.verdicts)) {
    for (const entry of parsed.verdicts as Record<string, unknown>[]) {
      const id = typeof entry?.id === 'string' ? entry.id : ''
      const verdict = entry?.verdict
      if (!id) continue
      if (verdict !== 'fits' && verdict !== 'does_not_fit' && verdict !== 'cannot_tell') continue
      byId.set(id, {
        sourceId: id,
        verdict,
        reason: typeof entry.reason === 'string' ? entry.reason : '',
      })
    }
  }

  return rows.map(r => byId.get(r.sourceId) ?? {
    sourceId: r.sourceId,
    verdict: 'cannot_tell' as const,
    reason: 'The judge returned no answer for this row.',
  })
}

// ─── The negative controls ───────────────────────────────────────────────────

export interface ControlOutcome {
  /** Rows from a deliberately wrong search. The judge must not approve them. */
  wrongSearchApproved: number
  wrongSearchTotal: number
  /** Rows whose employer name carries no meaning. The judge must abstain on them. */
  unknowableGuessed: number
  unknowableTotal: number
  reliable: boolean
  reason: string
}

/**
 * The most of a deliberately-wrong sample a trustworthy judge may approve.
 *
 * Zero would be the intuitive threshold and it is the wrong one: the wrong-search control is
 * built by swapping the client's classification codes for others, and a business can
 * genuinely sit under more than one code, so an occasional true "fits" is not evidence of a
 * broken judge. One in four is the point at which the control is no longer measuring a
 * mistake.
 */
export const MAX_WRONG_SEARCH_APPROVAL = 0.25

/**
 * The most of an unknowable sample a trustworthy judge may answer at all.
 *
 * These rows carry a synthesised employer token with no meaning in any language. There is
 * nothing to conclude from them, so ANY confident verdict is a guess. A small allowance
 * exists only because a job title can, occasionally, be one that could only exist in the kind
 * of organisation described, and the prompt permits that case explicitly.
 */
export const MAX_UNKNOWABLE_GUESS = 0.2

export function assessControls(
  wrongSearch: RawVerdict[],
  unknowable: RawVerdict[],
): ControlOutcome {
  const wrongApproved = wrongSearch.filter(v => v.verdict === 'fits').length
  const guessed = unknowable.filter(v => v.verdict !== 'cannot_tell').length

  const wrongRate = wrongSearch.length > 0 ? wrongApproved / wrongSearch.length : 0
  const guessRate = unknowable.length > 0 ? guessed / unknowable.length : 0

  // A control with no rows proves nothing, and reporting a judge reliable on the strength of
  // a control that never ran is the exact shape of a check that passes vacuously.
  if (wrongSearch.length === 0 || unknowable.length === 0) {
    return {
      wrongSearchApproved: wrongApproved,
      wrongSearchTotal: wrongSearch.length,
      unknowableGuessed: guessed,
      unknowableTotal: unknowable.length,
      reliable: false,
      reason:
        'Judge reliability was not established: one or both negative controls returned no ' +
        'rows, so nothing was proven either way. Treated as unreliable.',
    }
  }

  const failures: string[] = []
  if (wrongRate > MAX_WRONG_SEARCH_APPROVAL) {
    failures.push(
      `approved ${wrongApproved} of ${wrongSearch.length} rows from a deliberately wrong ` +
      `search (${(wrongRate * 100).toFixed(0)}%, limit ${MAX_WRONG_SEARCH_APPROVAL * 100}%)`,
    )
  }
  if (guessRate > MAX_UNKNOWABLE_GUESS) {
    failures.push(
      `answered ${guessed} of ${unknowable.length} rows whose employer name carries no ` +
      `meaning (${(guessRate * 100).toFixed(0)}%, limit ${MAX_UNKNOWABLE_GUESS * 100}%) ` +
      'instead of abstaining',
    )
  }

  return {
    wrongSearchApproved: wrongApproved,
    wrongSearchTotal: wrongSearch.length,
    unknowableGuessed: guessed,
    unknowableTotal: unknowable.length,
    reliable: failures.length === 0,
    reason: failures.length === 0
      ? `Both controls passed: rejected the wrong search and abstained on the unknowable sample.`
      : `Judge is unreliable this round. It ${failures.join(', and ')}. Its verdicts on the real ` +
        'sample are not used.',
  }
}

// ─── Reporting an agreement figure ───────────────────────────────────────────

export interface SampleAssessment {
  resolved: number
  fits: number
  doesNotFit: number
  cannotTell: number
  /** Null below MIN_RESOLVED_SAMPLE. Null is "not measured", never "zero". */
  agreement: number | null
  /** True when most answers stayed unresolved: the names in this market carry no signal. */
  lowNameSignal: boolean
  note: string
}

/** Above this share of unresolved answers, the market's names do not describe its businesses. */
export const LOW_NAME_SIGNAL_SHARE = 0.5

export function assessSample(verdicts: JudgedRow[]): SampleAssessment {
  const fits = verdicts.filter(v => v.verdict === 'fits').length
  const doesNotFit = verdicts.filter(v => v.verdict === 'does_not_fit').length
  const cannotTell = verdicts.filter(v => v.verdict === 'cannot_tell').length
  const resolved = fits + doesNotFit
  const lowNameSignal = verdicts.length > 0 && cannotTell / verdicts.length > LOW_NAME_SIGNAL_SHARE

  if (resolved < MIN_RESOLVED_SAMPLE) {
    return {
      resolved, fits, doesNotFit, cannotTell,
      agreement: null,
      lowNameSignal,
      note:
        `No agreement figure: ${resolved} of ${verdicts.length} rows resolved, ` +
        `${MIN_RESOLVED_SAMPLE} needed. A rate computed on this many would move by tens of ` +
        'percent on a single row, so none is reported.',
    }
  }

  const agreement = fits / resolved
  return {
    resolved, fits, doesNotFit, cannotTell,
    agreement,
    lowNameSignal,
    note:
      `${fits} of ${resolved} resolved rows fit (${(agreement * 100).toFixed(0)}%). ` +
      `${cannotTell} could not be told from a title and an employer name.`,
  }
}

/**
 * A synthesised employer token with no meaning in any language, for the unknowable control.
 *
 * BUILT, NOT WRITTEN DOWN. A hand-written example would be a company name in this file, and
 * a plausible-looking one would also be a real company somewhere. These are constructed from
 * a fixed consonant pattern and the row index, so they are reproducible, obviously synthetic,
 * and name nothing.
 */
export function unknowableEmployerToken(index: number): string {
  const stems = ['Zqv', 'Xtl', 'Vph', 'Kzr', 'Jwm', 'Qbx']
  return `${stems[index % stems.length]}-${(index * 7919) % 10000}`
}

export function buildUnknowableControl(count: number, jobTitles: string[]): SampleRow[] {
  return Array.from({ length: count }, (_, i) => ({
    sourceId: `control-unknowable-${i}`,
    firstName: null,
    // A real job title from the client's own search, so the control differs from the real
    // sample in exactly one respect: the employer name carries nothing.
    jobTitle: jobTitles.length > 0 ? jobTitles[i % jobTitles.length] : null,
    companyName: unknowableEmployerToken(i),
  }))
}

export function logJudgeOutcome(outcome: ControlOutcome, assessment: SampleAssessment): void {
  logger.info('tuner: judge round', {
    controls_reliable: outcome.reliable,
    wrong_search_approved: `${outcome.wrongSearchApproved}/${outcome.wrongSearchTotal}`,
    unknowable_guessed: `${outcome.unknowableGuessed}/${outcome.unknowableTotal}`,
    resolved: assessment.resolved,
    agreement: assessment.agreement,
    low_name_signal: assessment.lowNameSignal,
  })
}
