// The loop. Count, difference, sample, judge, adjust, recount, bounded.
//
// ─── THE ORDER, WHICH IS THE WHOLE DESIGN ────────────────────────────────────
//
//   ROUND ZERO   free. Count the population, difference every item, read the document's own
//                unresolved fields, measure the relaxation ceiling, count each tier. NO
//                MODEL CALL AND NO WEB LOOKUP HAPPEN HERE, and the loop asserts it rather
//                than trusting it. If round zero settles the run, nothing expensive is spent.
//
//   ONE CALL     only if round zero did not settle it. The document-reading agent runs ONCE
//                and its answer is reused by every later round. See below for why.
//
//   ROUNDS       sample, judge, adjust, recount. Bounded in count and in wall clock.
//
// ─── WHY THE DOCUMENT-READING AGENT IS CALLED ONCE ───────────────────────────
//
// NOT A PREFERENCE. MEASURED 2026-09-08: three identical calls to it on one live client
// returned accept lists of 11, 11 and 8 fragments and reject lists of 7, 4 and 3; on another
// client, 18/17/14 and 12/14/11. That is roughly a quarter of its output moving between
// identical calls.
//
// A loop that re-read it each round would measure that variance and attribute it to the
// changes it was making. Every round would look like it had done something. So it is called
// once, before the rounds, and the same answer is used throughout, which makes any movement
// between rounds attributable to the round.
//
// ─── WHAT DRIVES ADJUSTMENT ──────────────────────────────────────────────────
//
// Numbers. The judge is consulted to break a tie, or to catch a population that is
// numerically plausible and wrong, and it is never the thing that decides a change on its
// own. A judge that fails its controls is discarded for that round and the numbers stand.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { deriveBuyerCriterionWithVocabulary } from '@/agents/buyer-criterion-agent'
import { ProviderBudget, ProviderRateLimited, countAndSample } from '@/lib/tuner/count-and-sample'
import { runRoundZero, type ContractRequirement } from '@/lib/tuner/round-zero'
import { measureCandidateWords } from '@/lib/tuner/keywords'
import {
  anthropicJudge, assessControls, assessSample, buildUnknowableControl,
  type ClientContext, type JudgeFn,
} from '@/lib/tuner/judge'
import { LookupBudget, lookUpCompany, lookupIsUsable } from '@/lib/tuner/lookup'
import { resolveInstruction, type ResolvedInstruction } from '@/lib/tuner/instruction'
import { checkForbidden, boundsFromSpec } from '@/lib/tuner/forbidden'
import { findInFlight, describeInFlight, registerTunerRun, type TunerRunHandle } from '@/lib/tuner/in-flight'
import { ALL_TARGETABLE_NAICS_CODES } from '@/lib/sourcing/handlers/adapter-apollo'
import type {
  DocumentMarker, JudgedRow, ProposedChange, RoundRecord, TerminalState,
} from '@/lib/tuner/types'

/** Provider calls one run may make. Well under the 600/hour the provider allows. */
export const DEFAULT_PROVIDER_CALL_BUDGET = 220

/** How many adjusting rounds may run after round zero. */
export const DEFAULT_MAX_ROUNDS = 3

/**
 * Wall clock for the whole run.
 *
 * Against a 300-second platform ceiling and a measured 240-second working budget, this
 * leaves room for the round the check interrupts to finish and for the record to be written.
 * A run killed by the platform writes no terminal state at all, which is the one outcome
 * worse than any of the named failures.
 */
export const DEFAULT_WALL_CLOCK_MS = 200_000

/** Lookups one run may make. The only line here that costs money. */
export const DEFAULT_LOOKUP_CAP = 15

/** Rows sampled and judged per round. */
export const SAMPLE_SIZE = 25

/** Rows in each negative control. Both controls are mandatory. */
export const CONTROL_SIZE = 8

export interface TunerInput {
  supabase: SupabaseClient
  organisationId: string
  /** Verbatim operator complaint. Absent means a plain measurement of the current search. */
  instruction?: string
  contract?: ContractRequirement
  maxRounds?: number
  wallClockMs?: number
  lookupCap?: number
  providerCallBudget?: number
  /** Milliseconds between provider calls. Only a test sets this. */
  throttleMs?: number
  /** Injectable so the negative controls can be proven with a judge that always approves. */
  judge?: JudgeFn
  now?: () => number
}

export interface TunerResult {
  terminalState: TerminalState
  terminalReason: string
  rounds: RoundRecord[]
  baselinePopulation: number | null
  ceilingPopulation: number | null
  modelCalls: number
  billableSearches: number
  providerCalls: number
  documentMarker: DocumentMarker | null
  instruction: { text: string; resolution: string } | null
  plan: TuningPlan | null
  notes: string[]
}

/**
 * What the tuner proposes. NOTHING READS THIS.
 *
 * Shaped so a consumer can exist without a migration: it is one jsonb value, and everything
 * a reader needs to decide whether to trust it — which document it was built from, what it
 * measured, what it would change — is inside it or in the three marker columns beside it.
 */
export interface TuningPlan {
  builtFrom: DocumentMarker
  baselinePopulation: number
  ceilingPopulation: number
  proposedChanges: ProposedChange[]
  /** The measurement behind each change, in the operator's language. */
  evidence: string[]
  /** Stated on every plan so nobody has to infer it. */
  consumedBy: 'nothing'
}

export async function runTuner(input: TunerInput): Promise<TunerResult> {
  const {
    supabase, organisationId,
    maxRounds = DEFAULT_MAX_ROUNDS,
    wallClockMs = DEFAULT_WALL_CLOCK_MS,
    lookupCap = DEFAULT_LOOKUP_CAP,
    providerCallBudget = DEFAULT_PROVIDER_CALL_BUDGET,
    throttleMs,
    judge = anthropicJudge,
    now = () => Date.now(),
  } = input

  const startedAt = now()
  const outOfTime = () => now() - startedAt > wallClockMs

  const budget = new ProviderBudget(providerCallBudget, throttleMs)
  const lookups = new LookupBudget(lookupCap)
  const rounds: RoundRecord[] = []
  const notes: string[] = []
  let modelCalls = 0

  const finish = (
    state: TerminalState, reason: string,
    extra: Partial<TunerResult> = {},
  ): TunerResult => ({
    terminalState: state,
    terminalReason: reason,
    rounds,
    baselinePopulation: null,
    ceilingPopulation: null,
    modelCalls,
    billableSearches: lookups.billableSearches,
    providerCalls: budget.calls,
    documentMarker: null,
    instruction: null,
    plan: null,
    notes,
    ...extra,
  })

  // ── The instruction, resolved before anything is spent ──
  let resolved: ResolvedInstruction | null = null
  if (input.instruction !== undefined) {
    resolved = resolveInstruction(input.instruction)
    if (!resolved.actionable) {
      return finish('forbidden_change_required', resolved.resolution, {
        instruction: { text: input.instruction, resolution: resolved.resolution },
      })
    }
    notes.push(resolved.resolution)
  }

  // ── The in-flight guard ──
  const inFlight = await findInFlight(supabase, organisationId)
  if (inFlight) {
    return finish('failed', describeInFlight(inFlight), {
      instruction: input.instruction !== undefined && resolved
        ? { text: input.instruction, resolution: resolved.resolution }
        : null,
    })
  }

  // ── Announce this run, so a concurrent sourcing run refuses ──
  //
  // AFTER the check and BEFORE any provider call. Checking without announcing is a guard that
  // reads as symmetric and is not: the tuner would see sourcing and sourcing would not see the
  // tuner, and sourcing is the path that paginates hard against the shared rate limit.
  const announced: TunerRunHandle = await registerTunerRun(supabase, organisationId)

  // Every return after this point goes through here, so the announcement is always closed.
  // A row left 'running' blocks this organisation for ten minutes until the reaper clears it.
  const close = async <T extends TunerResult>(result: T): Promise<T> => {
    if (result.terminalState === 'failed') await announced.fail(result.terminalReason)
    else await announced.complete(`${result.terminalState}: ${result.rounds.length} round(s)`)
    return result
  }

  // ── The document, and the marker that says which version this run saw ──
  const { data: doc, error: docError } = await supabase
    .from('strategy_documents')
    .select('id, version, updated_at, content, icp_filter_spec')
    .eq('organisation_id', organisationId)
    .eq('document_type', 'icp')
    .eq('status', 'active')
    .single()

  if (docError || !doc) {
    return close(finish('failed', `No active ICP document for this organisation: ${docError?.message ?? 'not found'}`))
  }
  if (!doc.icp_filter_spec) {
    return close(finish('failed',
      'The active ICP carries no filter spec, so there is no search to tune. Re-approving the ' +
      'ICP derives one.'))
  }

  const marker: DocumentMarker = {
    documentId: doc.id as string,
    version: String(doc.version),
    updatedAt: String(doc.updated_at),
  }
  const spec = doc.icp_filter_spec as Record<string, unknown>
  const icpContent = (doc.content ?? {}) as Record<string, unknown>

  const withMarker = (state: TerminalState, reason: string, extra: Partial<TunerResult> = {}) =>
    close(finish(state, reason, {
      documentMarker: marker,
      instruction: input.instruction !== undefined && resolved
        ? { text: input.instruction, resolution: resolved.resolution }
        : null,
      ...extra,
    }))

  // ── ROUND ZERO. Free. ──
  let zero
  try {
    zero = await runRoundZero({
      supabase, organisationId, spec, icpContent, budget, contract: input.contract,
    })
  } catch (err) {
    if (err instanceof ProviderRateLimited) {
      return withMarker('rate_limit_reached', rateLimitReason(err, budget.calls))
    }
    return withMarker('failed', err instanceof Error ? err.message : String(err))
  }

  notes.push(...zero.notes)

  rounds.push({
    index: 0, kind: 'zero',
    population: zero.population,
    differencing: zero.differencing,
    tierCounts: zero.tierCounts,
    unresolvedFields: zero.unresolvedFields,
    changeProposed: null, changeReason: null,
    judged: null, judgeResolvedSample: null, judgeAgreement: null, judgeReliable: null,
    // ASSERTED, NOT ASSUMED. Round zero is free by construction and these three zeros are
    // what a test reads to prove the ordering held.
    modelCalls: 0, billableSearches: 0,
    providerCalls: budget.calls,
  })

  const populations = { baselinePopulation: zero.population, ceilingPopulation: zero.ceiling.ceiling }

  if (zero.terminal) {
    return withMarker(zero.terminal.state, zero.terminal.reason, populations)
  }

  if (zero.differencing.suspectedIgnoredAxes.length > 0) {
    return withMarker('provider_ignored_a_parameter',
      `The ${zero.differencing.suspectedIgnoredAxes.join(' and ')} layer is populated, removing ` +
      'it changes the population by nothing, and no member of it finds anybody on its own. That ' +
      'is the shape of a parameter the provider never applied. Tuning a search with a parameter ' +
      'that does nothing would attribute every later change to the wrong cause, so this stops ' +
      'here. Confirm by re-issuing the same values under a deliberately misspelled parameter ' +
      'name: if the count matches, the parameter is being ignored.',
      populations)
  }

  // ── THE ONE MODEL CALL. Only now, and only once. ──
  if (outOfTime()) {
    return withMarker('wall_clock_exhausted',
      `The wall clock ran out during round zero after ${budget.calls} free provider calls. No ` +
      'model call was made.', populations)
  }

  let vocabulary
  try {
    const derived = await deriveBuyerCriterionWithVocabulary({ supabase, organisation_id: organisationId })
    modelCalls += 1
    vocabulary = derived.vocabulary
  } catch (err) {
    return withMarker('failed',
      `The document-reading call failed, so there is no description of what this client sells ` +
      `to judge against and no candidate words to measure: ${err instanceof Error ? err.message : String(err)}`,
      populations)
  }

  if (!vocabulary.sells || !vocabulary.usedFor) {
    return withMarker('name_signal_too_low',
      'The document-reading call returned no usable description of what this client sells, so ' +
      'the judge has nothing to judge against. The numbers from round zero stand and are ' +
      'recorded; no sample was judged.', populations)
  }

  const context: ClientContext = { sells: vocabulary.sells, usedFor: vocabulary.usedFor }

  // ── ROUNDS ──
  const proposed: ProposedChange[] = []
  const evidence: string[] = []
  let request = zero.request
  let population = zero.population
  let improved = false

  for (let index = 1; index <= maxRounds; index++) {
    if (outOfTime()) {
      return withMarker('wall_clock_exhausted',
        `The wall clock ran out after ${index - 1} of ${maxRounds} adjusting rounds. ` +
        describeSpend(modelCalls, lookups, budget), populations)
    }

    const round: RoundRecord = {
      index, kind: 'adjust',
      population: null, differencing: null, tierCounts: null, unresolvedFields: null,
      changeProposed: null, changeReason: null,
      judged: null, judgeResolvedSample: null, judgeAgreement: null, judgeReliable: null,
      modelCalls: 0, billableSearches: 0, providerCalls: 0,
    }
    const callsBefore = budget.calls
    const searchesBefore = lookups.billableSearches

    let outcome
    try {
      outcome = await runOneRound({
        request, population, context, judge, budget, lookups, spec,
        vocabularyWords: vocabulary.nameWords,
      })
    } catch (err) {
      if (err instanceof ProviderRateLimited) {
        round.providerCalls = budget.calls - callsBefore
        rounds.push(round)
        return withMarker('rate_limit_reached', rateLimitReason(err, budget.calls), populations)
      }
      throw err
    }

    round.modelCalls = outcome.modelCalls
    modelCalls += outcome.modelCalls
    round.billableSearches = lookups.billableSearches - searchesBefore
    round.providerCalls = budget.calls - callsBefore
    round.judged = outcome.judged
    round.judgeResolvedSample = outcome.assessment.resolved
    round.judgeAgreement = outcome.assessment.agreement
    round.judgeReliable = outcome.controls.reliable
    round.population = outcome.population
    round.changeProposed = outcome.change
    round.changeReason = outcome.reason
    rounds.push(round)

    if (!outcome.controls.reliable) {
      return withMarker('judge_unreliable', outcome.controls.reason, populations)
    }

    if (lookups.exhausted && outcome.assessment.lowNameSignal) {
      return withMarker('lookup_budget_exhausted',
        `The lookup cap of ${lookupCap} was reached and most rows are still unresolved. ` +
        `${lookups.billableSearches} billable searches were returned across ${lookups.lookups} ` +
        `lookups. The remaining unknowns stay unknown. ${outcome.assessment.note}`, populations)
    }

    if (outcome.assessment.lowNameSignal) {
      return withMarker('name_signal_too_low',
        `${outcome.assessment.note} The organisation names in this client's market do not ` +
        'describe what the organisations do, so judging a sample cannot settle whether the ' +
        'search is right. The numbers stand: they are recorded on every round and are the ' +
        'only evidence this run can offer.', populations)
    }

    if (outcome.change) {
      proposed.push(outcome.change)
      evidence.push(outcome.change.evidence)
      request = outcome.request
      if (outcome.population < population) improved = true
      population = outcome.population
    } else {
      break
    }
  }

  if (proposed.length === 0) {
    return withMarker('no_round_improved',
      'No round found a change that both the numbers and the judge supported. The search is ' +
      'recorded as measured and nothing is proposed. ' + describeSpend(modelCalls, lookups, budget),
      populations)
  }

  const plan: TuningPlan = {
    builtFrom: marker,
    baselinePopulation: zero.population,
    ceilingPopulation: zero.ceiling.ceiling,
    proposedChanges: proposed,
    evidence,
    consumedBy: 'nothing',
  }

  return withMarker('accepted',
    `${proposed.length} change${proposed.length === 1 ? '' : 's'} proposed, each supported by a ` +
    `measurement and by a judge that passed both negative controls. The population moves from ` +
    `${zero.population} to ${population}; the ceiling with buyer constraints relaxed is ` +
    `${zero.ceiling.ceiling}. ${improved ? '' : 'No round reduced the population. '}` +
    'Nothing consumes this plan: it is stored for a person to read and approve. ' +
    describeSpend(modelCalls, lookups, budget),
    { ...populations, plan })
}

// ─── One adjusting round ─────────────────────────────────────────────────────

interface RoundOutcome {
  judged: JudgedRow[]
  assessment: ReturnType<typeof assessSample>
  controls: ReturnType<typeof assessControls>
  change: ProposedChange | null
  reason: string
  request: Record<string, unknown>
  population: number
  modelCalls: number
}

async function runOneRound(ctx: {
  request: Record<string, unknown>
  population: number
  context: ClientContext
  judge: JudgeFn
  budget: ProviderBudget
  lookups: LookupBudget
  spec: Record<string, unknown>
  vocabularyWords: string[]
}): Promise<RoundOutcome> {
  const { request, context, judge, budget, lookups, spec } = ctx

  const sample = await countAndSample(request, budget, SAMPLE_SIZE)

  // ── The two negative controls. BOTH MANDATORY. ──
  const wrongRows = await buildWrongSearchControl(request, budget)
  const unknowableRows = buildUnknowableControl(
    CONTROL_SIZE,
    sample.rows.map(r => r.jobTitle ?? '').filter(t => t.length > 0),
  )

  // One model call carrying the real sample and both controls together, so the judge cannot
  // treat a control differently from the thing it is controlling for. Separate calls would
  // measure a different judge on each.
  const all = [...sample.rows, ...wrongRows, ...unknowableRows]
  const { verdicts, modelCalls } = await judge({ rows: all, context })
  const byId = new Map(verdicts.map(v => [v.sourceId, v]))

  const pick = (ids: Set<string>) => verdicts.filter(v => ids.has(v.sourceId))
  const controls = assessControls(
    pick(new Set(wrongRows.map(r => r.sourceId))),
    pick(new Set(unknowableRows.map(r => r.sourceId))),
  )

  // ── Lookups, only where the judge could not tell, and only on the real sample ──
  const judged: JudgedRow[] = []
  for (const row of sample.rows) {
    const v = byId.get(row.sourceId)
    let verdict = v?.verdict ?? 'cannot_tell'
    let reason = v?.reason ?? ''
    let lookupText: string | null = null
    let lookupSearches = 0

    if (verdict === 'cannot_tell' && row.companyName) {
      const result = await lookUpCompany(row.companyName, lookups)
      if (result) {
        lookupText = result.text
        lookupSearches = result.billableSearches
      }
      // A LOOKUP THAT RETURNED NOTHING USEFUL DOES NOT BECOME A VERDICT. The row stays
      // unresolved and says so. Turning thin text into a confident answer is worse than the
      // original "cannot tell", because it looks like knowledge.
      if (!lookupIsUsable(result)) {
        reason = result === null
          ? 'Still unknown: the lookup cap was reached before this row.'
          : 'Still unknown: the lookup returned nothing usable about this organisation.'
      } else {
        reason = `${reason} Looked up; see the stored lookup text.`.trim()
      }
      verdict = 'cannot_tell'
    }

    judged.push({
      sourceId: row.sourceId,
      jobTitle: row.jobTitle,
      companyName: row.companyName,
      verdict,
      reason,
      lookupText,
      lookupBillableSearches: lookupSearches,
    })
  }

  const assessment = assessSample(judged)

  // ── Adjustment. NUMBERS DECIDE. ──
  //
  // The only change the tuner may make is adding a measured search word: every other action
  // either widens past the client's document or removes something the document states. See
  // forbidden.ts. So the judge cannot cause a change on its own — it can only withhold one,
  // by failing its controls or by leaving the population unresolved.
  const measurement = await measureCandidateWords(request, ctx.vocabularyWords, budget)
  const bounds = boundsFromSpec(spec, request)

  for (const candidate of measurement.candidates) {
    if (!candidate.keep) continue
    const change: ProposedChange = {
      axis: 'search_word',
      action: 'add_word',
      index: null,
      value: candidate.word,
      evidence:
        `${candidate.reason} Derived from the client's own documents, not from the name of a ` +
        `classification bucket, and measured against the provider before being proposed.`,
    }
    const verdict = checkForbidden(change, bounds)
    if (verdict.forbidden) continue

    const next = { ...request, q_organization_keyword_tags: [candidate.word] }
    const after = (await countAndSample(next, budget)).total
    return {
      judged, assessment, controls, change,
      reason: change.evidence,
      request: next,
      population: after,
      modelCalls,
    }
  }

  return {
    judged, assessment, controls,
    change: null,
    reason:
      measurement.candidates.length === 0
        ? 'The document-reading call returned no candidate words to measure.'
        : `All ${measurement.candidates.length} candidate words were measured and none narrowed ` +
          `the search usefully: ${measurement.candidates.map(c => c.reason).join(' ')}`,
    request,
    population: ctx.population,
    modelCalls,
  }
}

/**
 * A sample from a deliberately wrong search, which a trustworthy judge must reject.
 *
 * BUILT AT RUN TIME FROM CODES THIS CLIENT DOES NOT USE, so nothing here writes down a
 * sector. It holds the client's own geography, size and buyer constraints and changes only
 * the classification bucket, so the judge is being asked about the same kind of person at a
 * different kind of organisation — which is exactly the mistake it exists to catch.
 */
async function buildWrongSearchControl(
  request: Record<string, unknown>,
  budget: ProviderBudget,
) {
  const own = new Set(
    Array.isArray(request.organization_naics_codes) ? (request.organization_naics_codes as string[]) : [],
  )
  const others = ALL_TARGETABLE_NAICS_CODES.filter(c => !own.has(c))
  if (others.length === 0) return []

  // Spread across the taxonomy rather than taking the first few, so the control is not
  // always drawn from one corner of it.
  const step = Math.max(1, Math.floor(others.length / CONTROL_SIZE))
  const picked = Array.from({ length: CONTROL_SIZE }, (_, i) => others[(i * step) % others.length])

  const wrong: Record<string, unknown> = { ...request, organization_naics_codes: [...new Set(picked)] }
  delete wrong.q_organization_keyword_tags

  const result = await countAndSample(wrong, budget, CONTROL_SIZE)
  return result.rows.map((r, i) => ({ ...r, sourceId: `control-wrong-${i}-${r.sourceId}` }))
}

function rateLimitReason(err: ProviderRateLimited, calls: number): string {
  return (
    `The provider rate limited this run after ${calls} calls. Its documented limit is 600 ` +
    `requests an hour and it is shared with sourcing, which runs under the same account. ` +
    `Retry-After: ${err.retryAfter ?? 'not provided'}. The tuner stops rather than retrying ` +
    'into the limit: every retry spends the same shared budget that a sourcing run may be ' +
    'waiting on, and the measurements already taken are recorded.'
  )
}

function describeSpend(modelCalls: number, lookups: LookupBudget, budget: ProviderBudget): string {
  return (
    `Spent: ${modelCalls} model call${modelCalls === 1 ? '' : 's'}, ${lookups.billableSearches} ` +
    `billable search${lookups.billableSearches === 1 ? '' : 'es'} across ${lookups.lookups} ` +
    `lookup${lookups.lookups === 1 ? '' : 's'}, ${budget.calls} free provider calls.`
  )
}
