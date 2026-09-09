// The loop that measures a search, judges what it returns, and proposes something better.
//
// ─── THE ORDER, WHICH IS THE DESIGN ──────────────────────────────────────────
//
//   ROUND ZERO   free. Count, difference every element, measure the ceiling with the buyer
//                constraints relaxed. NO MODEL CALL AND NO RESEARCH. If the population
//                cannot support the work, the run ends here having spent nothing.
//
//   ONE CALL     the whole-document derivation, once, reused by every round. It is the same
//                call that already owned job titles and seniority bands.
//
//   ROUNDS       draw a spread sample, research every company in it, judge each against the
//                client's own document, compare on fit AND reach, adjust, repeat.
//
// ─── WHAT IT OPTIMISES, AND THE TRAP IT AVOIDS ───────────────────────────────
//
// Optimising fit alone rewards making the search tiny: four companies, all perfect, scores
// 100% and serves nobody. So every candidate is judged on fit AND reach, the two are always
// reported separately, and a candidate below the required audience is rejected on reach
// whatever its sample looked like. Where no required audience was supplied the run says it
// cannot judge rather than assuming one.
//
// NOTHING HERE WRITES A CLIENT'S SPEC, DOCUMENT OR PROSPECTS.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { buildApolloRequest } from '@/lib/sourcing/handlers/adapter-apollo'
import { deriveBuyerCriterionWithVocabulary } from '@/agents/buyer-criterion-agent'
import { ProviderBudget, ProviderRateLimited, countAndSample } from '@/lib/tuner/count-and-sample'
import { differenceSearch } from '@/lib/tuner/differencing'
import { measureCeiling } from '@/lib/tuner/relaxation-ceiling'
import { drawSpreadSample, DEFAULT_SAMPLE_SIZE } from '@/lib/tuner/spread-sample'
import { lookUpCompany, lookupIsUsable, LookupBudget } from '@/lib/tuner/lookup'
import {
  anthropicFitJudge, assessFit, compareFit, logFitRound, MIN_FIT_IMPROVEMENT,
  type FitContext, type FitJudgeFn, type FitOutcome, type JudgedCompany,
} from '@/lib/tuner/fit-judge'
import { SpendBudget, checkAudience, DEFAULT_SPEND_CAP_SEARCHES, type AudienceFloor } from '@/lib/tuner/run-budget'
import { findInFlight, describeInFlight, registerTunerRun, type TunerRunHandle } from '@/lib/tuner/in-flight'
import { proposalIsEmpty, statedShare, type ProposedSearch } from '@/lib/tuner/proposed-search'
import { checkCountriesPermitted } from '@/lib/tuner/forbidden'
import type { DocumentMarker } from '@/lib/tuner/types'

/**
 * How a search-tuning run ended. EVERY OUTCOME IS DISTINCT AND NAMED, and no name is a
 * substring of another, so a UI matching on substrings cannot render two as one.
 */
export const SEARCH_TERMINAL_STATES = [
  'accepted',
  'audience_cannot_support_the_work',
  'no_combination_reached_the_standard',
  'derivation_refused',
  'spend_cap_reached',
  'wall_clock_exhausted',
  'rate_limit_reached',
  'provider_ignored_a_parameter',
  'taxonomy_cannot_express_the_document',
  'failed',
] as const
export type SearchTerminalState = (typeof SEARCH_TERMINAL_STATES)[number]

export interface SearchTunerInput {
  supabase: SupabaseClient
  organisationId: string
  /** Required to reject a candidate for being too small. No default; see run-budget.ts. */
  audienceFloor?: AudienceFloor
  sampleSize?: number
  spendCapSearches?: number
  maxRounds?: number
  wallClockMs?: number
  providerCallBudget?: number
  fitJudge?: FitJudgeFn
  now?: () => number
  random?: () => number
}

export interface RoundReport {
  index: number
  kind: 'zero' | 'adjust'
  reachable: number
  ceiling: number | null
  fit: FitOutcome | null
  judged: JudgedCompany[] | null
  changeDescription: string | null
  comparisonNote: string | null
  audienceNote: string | null
  billableSearches: number
  modelCalls: number
  providerCalls: number
}

export interface SearchTunerResult {
  terminalState: SearchTerminalState
  terminalReason: string
  rounds: RoundReport[]
  baselineReachable: number | null
  ceilingReachable: number | null
  proposal: ProposedSearch | null
  documentMarker: DocumentMarker | null
  /** The measured noise floor this run compared against, stored so it can be re-derived. */
  noiseFloor: number
  billableSearches: number
  modelCalls: number
  providerCalls: number
  notes: string[]
  consumedBy: 'nothing'
}

/**
 * The smallest population worth researching.
 *
 * DERIVED, not chosen: a round cannot report a proportion below the fit judge's own resolved
 * floor, and a population smaller than the sample cannot fill one. Researching it would spend
 * money to learn something the count already said.
 */
export const MIN_POPULATION_TO_RESEARCH = DEFAULT_SAMPLE_SIZE

export async function runSearchTuner(input: SearchTunerInput): Promise<SearchTunerResult> {
  const {
    supabase, organisationId,
    sampleSize = DEFAULT_SAMPLE_SIZE,
    spendCapSearches = DEFAULT_SPEND_CAP_SEARCHES,
    maxRounds = 3,
    wallClockMs = 900_000,
    providerCallBudget = 600,
    fitJudge = anthropicFitJudge,
    now = () => Date.now(),
    random = Math.random,
  } = input

  const startedAt = now()
  const outOfTime = () => now() - startedAt > wallClockMs
  const provider = new ProviderBudget(providerCallBudget)
  const spend = new SpendBudget(spendCapSearches)
  const lookups = new LookupBudget(Number.MAX_SAFE_INTEGER) // the spend cap is the real bound
  const rounds: RoundReport[] = []
  const notes: string[] = []
  let modelCalls = 0
  let announced: TunerRunHandle = { runId: null, complete: async () => {}, fail: async () => {} }

  const finish = (
    state: SearchTerminalState, reason: string, extra: Partial<SearchTunerResult> = {},
  ): SearchTunerResult => ({
    terminalState: state, terminalReason: reason, rounds,
    baselineReachable: null, ceilingReachable: null, proposal: null, documentMarker: null,
    noiseFloor: MIN_FIT_IMPROVEMENT,
    billableSearches: spend.billableSearches, modelCalls, providerCalls: provider.calls,
    notes, consumedBy: 'nothing', ...extra,
  })

  const close = async (r: SearchTunerResult) => {
    if (r.terminalState === 'failed') await announced.fail(r.terminalReason)
    else await announced.complete(`${r.terminalState}: ${r.rounds.length} round(s)`)
    return r
  }

  // ── The shared guard ──
  const inFlight = await findInFlight(supabase, organisationId)
  if (inFlight) return finish('failed', describeInFlight(inFlight))
  announced = await registerTunerRun(supabase, organisationId)

  // ── The document, and the marker ──
  const { data: doc, error } = await supabase
    .from('strategy_documents')
    .select('id, version, updated_at, content, icp_filter_spec')
    .eq('organisation_id', organisationId).eq('document_type', 'icp').eq('status', 'active').single()

  if (error || !doc) return close(finish('failed', `No active ICP: ${error?.message ?? 'not found'}`))
  if (!doc.icp_filter_spec) {
    return close(finish('failed', 'The active ICP carries no filter spec, so there is no search to tune.'))
  }

  const marker: DocumentMarker = {
    documentId: doc.id as string, version: String(doc.version), updatedAt: String(doc.updated_at),
  }
  const spec = doc.icp_filter_spec as Record<string, unknown>
  const withMarker = (s: SearchTerminalState, r: string, e: Partial<SearchTunerResult> = {}) =>
    close(finish(s, r, { documentMarker: marker, ...e }))

  // ── ROUND ZERO. Free. ──
  let request: Record<string, unknown>
  try { request = buildApolloRequest(spec) } catch (e) {
    return withMarker('derivation_refused',
      `The stored search cannot be built, so there is nothing to measure against: ` +
      `${e instanceof Error ? e.message : String(e)}`)
  }

  let zero
  try {
    const differencing = await differenceSearch(request, provider)
    const ceiling = await measureCeiling(request, provider, differencing.population)
    zero = { differencing, ceiling }
  } catch (e) {
    if (e instanceof ProviderRateLimited) return withMarker('rate_limit_reached', rateLimitReason(e, provider.calls))
    return withMarker('failed', e instanceof Error ? e.message : String(e))
  }

  const reachable = zero.differencing.population
  rounds.push({
    index: 0, kind: 'zero', reachable, ceiling: zero.ceiling.ceiling,
    fit: null, judged: null, changeDescription: null, comparisonNote: null,
    audienceNote: null,
    // ASSERTED, not assumed. Round zero is free by construction.
    billableSearches: 0, modelCalls: 0, providerCalls: provider.calls,
  })
  const populations = { baselineReachable: reachable, ceilingReachable: zero.ceiling.ceiling }

  notes.push(
    `Reachable as configured ${reachable}; with the buyer constraints relaxed ${zero.ceiling.ceiling}. ` +
    'Both are reported on every run so "this search is too tight" and "this audience does not ' +
    'exist" are a measured difference rather than an inference.',
  )

  if (zero.differencing.suspectedIgnoredAxes.length > 0) {
    return withMarker('provider_ignored_a_parameter',
      `The ${zero.differencing.suspectedIgnoredAxes.join(' and ')} layer is populated, removing it ` +
      'changes the population by nothing, and no member of it finds anybody alone. That is the ' +
      'shape of a parameter the provider never applied, and tuning around one would attribute ' +
      'every later change to the wrong cause.', populations)
  }

  const audience = checkAudience(reachable, input.audienceFloor)
  if (!audience.judged) notes.push(audience.reason)

  if (reachable < MIN_POPULATION_TO_RESEARCH) {
    return withMarker('audience_cannot_support_the_work',
      `The search reaches ${reachable}, below the ${MIN_POPULATION_TO_RESEARCH} needed to fill one ` +
      `sample. With the buyer constraints relaxed it reaches ${zero.ceiling.ceiling}. No model call ` +
      'and no research were spent, because neither could have produced information.', populations)
  }
  if (audience.judged && !audience.acceptable) {
    return withMarker('audience_cannot_support_the_work', audience.reason, populations)
  }

  // ── THE ONE MODEL CALL ──
  if (outOfTime()) {
    return withMarker('wall_clock_exhausted',
      `The wall clock ran out during round zero after ${provider.calls} free provider calls. ` +
      'No model call and no research were made.', populations)
  }

  let derived
  try {
    derived = await deriveBuyerCriterionWithVocabulary({ supabase, organisation_id: organisationId })
    modelCalls += 1
  } catch (e) {
    return withMarker('derivation_refused',
      'The whole-document derivation failed, so there is no proposed search and nothing to ' +
      `judge against: ${e instanceof Error ? e.message : String(e)}`, populations)
  }

  const proposal = derived.search
  if (proposalIsEmpty(proposal)) {
    return withMarker('derivation_refused',
      'The derivation returned no traceable search elements. Every element it proposed was ' +
      'dropped for having no reason pointing at something the document states, which is the ' +
      'guard against inventing a market rather than a fault in the loop. ' +
      `Dropped: ${JSON.stringify(proposal.droppedUntraceable)}.`, { ...populations, proposal })
  }

  const forbidden = checkCountriesPermitted(proposal.places.map(p => p.value))
  if (forbidden.forbidden) {
    return withMarker('derivation_refused', forbidden.reason, { ...populations, proposal })
  }

  const traced = statedShare(proposal)
  notes.push(
    `Proposal: ${proposal.categories.length} categories, ${proposal.words.length} words, ` +
    `${proposal.places.length} places, ${proposal.omit.length} deliberate omissions. ` +
    (traced.share !== null
      ? `${traced.stated} of ${traced.stated + traced.inferred} elements are stated by the document rather than inferred.`
      : 'No elements to attribute.'),
  )

  const context: FitContext = {
    sells: derived.vocabulary.sells,
    usedFor: derived.vocabulary.usedFor,
    bestDescription: proposal.categories.map(c => c.value).join('; ') || derived.vocabulary.sells,
    acceptableDescription: proposal.words.map(w => w.value).join('; ') || derived.vocabulary.usedFor,
  }

  // ── ROUNDS ──
  let baseline: FitOutcome | null = null
  for (let index = 1; index <= maxRounds; index++) {
    if (outOfTime()) {
      return withMarker('wall_clock_exhausted',
        `The wall clock ran out after ${index - 1} of ${maxRounds} rounds. ${spend.describe()}.`,
        { ...populations, proposal })
    }
    // STOPS BEFORE A ROUND, NOT INSIDE ONE. A half-paid sample is a biased sample.
    if (!spend.canAffordRound(sampleSize)) {
      return withMarker('spend_cap_reached',
        `The spend cap stopped this run cleanly before round ${index} rather than part way ` +
        `through a sample, because a partial sample is biased towards whatever the provider ` +
        `returned first. ${spend.describe()}.`, { ...populations, proposal })
    }

    let round: RoundReport
    try {
      round = await runOneRound({
        index, request, provider, spend, lookups, sampleSize, context, fitJudge, random,
      })
    } catch (e) {
      if (e instanceof ProviderRateLimited) {
        return withMarker('rate_limit_reached', rateLimitReason(e, provider.calls), { ...populations, proposal })
      }
      throw e
    }
    modelCalls += round.modelCalls

    if (baseline && round.fit) {
      const cmp = compareFit(baseline, round.fit)
      round.comparisonNote = cmp.note
    }
    rounds.push(round)
    if (!baseline) baseline = round.fit

    if (round.fit?.lowSignal) {
      return withMarker('no_combination_reached_the_standard',
        `Most rows could not be established even after research: ${round.fit.cannotEstablish} of ` +
        `${round.fit.sampled}. The organisation names in this market do not describe what the ` +
        `organisations do, so a researched sample cannot settle whether the search is right. ` +
        `The numbers stand: reachable ${reachable}, ceiling ${zero.ceiling.ceiling}. ${spend.describe()}.`,
        { ...populations, proposal })
    }
  }

  const best = rounds.filter(r => r.fit).slice(-1)[0]?.fit ?? null
  return withMarker('no_combination_reached_the_standard',
    `Ran ${rounds.length - 1} researched round(s) and no candidate cleared the measured noise ` +
    `floor of ${(MIN_FIT_IMPROVEMENT * 100).toFixed(0)} points. Best attempt: ` +
    (best
      ? `${best.best} best, ${best.acceptable} acceptable, ${best.neither} neither, ` +
        `${best.cannotEstablish} unestablished of ${best.sampled}; fit of resolved ` +
        `${best.fitOfResolved !== null ? (best.fitOfResolved * 100).toFixed(1) + '%' : 'not reportable'}`
      : 'none measurable') +
    `. Reachable ${reachable}, ceiling ${zero.ceiling.ceiling}. ${spend.describe()}. ` +
    'This is a finding, not a question: what was tried and how it scored is recorded above.',
    { ...populations, proposal })
}

async function runOneRound(ctx: {
  index: number
  request: Record<string, unknown>
  provider: ProviderBudget
  spend: SpendBudget
  lookups: LookupBudget
  sampleSize: number
  context: FitContext
  fitJudge: FitJudgeFn
  random: () => number
}): Promise<RoundReport> {
  const callsBefore = ctx.provider.calls
  const searchesBefore = ctx.spend.billableSearches

  const sample = await drawSpreadSample(ctx.request, ctx.provider, ctx.sampleSize, ctx.random)

  // Research every sampled company. This is the only part that costs money.
  const researched: (typeof sample.rows[number] & { researchText: string | null; billable: number })[] = []
  for (const row of sample.rows) {
    if (!row.companyName) { researched.push({ ...row, researchText: null, billable: 0 }); continue }
    const result = await lookUpCompany(row.companyName, ctx.lookups)
    const billable = result?.billableSearches ?? 0
    ctx.spend.record(billable)
    researched.push({
      ...row,
      researchText: lookupIsUsable(result) ? result!.text : null,
      billable,
    })
  }

  const { verdicts, modelCalls } = await ctx.fitJudge(researched, ctx.context)
  const byId = new Map(verdicts.map(v => [v.sourceId, v]))
  const judged: JudgedCompany[] = researched.map(r => ({
    sourceId: r.sourceId, jobTitle: r.jobTitle, companyName: r.companyName,
    verdict: byId.get(r.sourceId)?.verdict ?? 'cannot_establish',
    reason: byId.get(r.sourceId)?.reason ?? 'No answer returned for this row.',
    researchText: r.researchText,
    billableSearches: r.billable,
  }))

  const fit = assessFit(judged)
  logFitRound(fit)

  return {
    index: ctx.index, kind: 'adjust', reachable: sample.total, ceiling: null,
    fit, judged, changeDescription: null, comparisonNote: null, audienceNote: null,
    billableSearches: ctx.spend.billableSearches - searchesBefore,
    modelCalls,
    providerCalls: ctx.provider.calls - callsBefore,
  }
}

function rateLimitReason(err: ProviderRateLimited, calls: number): string {
  return (
    `The provider rate limited this run after ${calls} calls. Its limit is 600 requests an hour ` +
    `and it is shared with sourcing under the same account. Retry-After: ${err.retryAfter ?? 'not provided'}. ` +
    'The tuner stops rather than retrying into it, because every retry spends the same shared ' +
    'budget a sourcing run may be waiting on.'
  )
}

