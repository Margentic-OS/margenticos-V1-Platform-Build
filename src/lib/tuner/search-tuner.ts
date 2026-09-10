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
//   ROUNDS       draw a spread sample, research the companies in it, judge each against the
//                client's own document, compare on fit AND reach, adjust, repeat.
//
// ─── WHAT A ROUND COSTS, MEASURED RATHER THAN ASSUMED ────────────────────────
//
// Every lookup is billed three ways and until 2026-09-09 this project counted one of them.
// Measured that day over 40 paired lookups on a live client, per batch of 80: search fee
// $1.18, lookup tokens $0.92, judge $0.12. The fee was 57% of a lookup, so a cap counted in
// searches bounded just over half the bill.
//
// The reading was then narrowed to one question with an explicit instruction to answer from
// the first result set. Billable searches fell from 1.48 per lookup to 1.00, every lookup
// answered in one search, and a batch of 80 fell from $2.22 to $1.77. THE VERDICTS HELD: 33
// of 40 unchanged, against a judge that moves 6 of 40 on IDENTICAL input, so the difference
// is inside the judge's own noise and not attributable to reading less.
//
// WHAT COULD NOT BE CUT: the page text itself, 9,619 input tokens per lookup and essentially
// unchanged by the narrower question. The server-side search tool has no max_content_tokens
// field in any version the SDK exposes, so how much page arrives is the provider's decision
// and there is no parameter at any price that changes it.
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
import { lookUpMany, lookupIsUsable, LookupBudget } from '@/lib/tuner/lookup'
import { PRICE_PER_BILLABLE_SEARCH, tokenCost } from '@/lib/tuner/pricing'
import {
  anthropicNameSignal, checkNameSignal, isDecided, logNameSignal, oneVerdictWorth,
  type NameSignalDecision, type NameSignalFn, type NameSignalVerdict,
} from '@/lib/tuner/name-signal'
import {
  anthropicFitJudge, assessFit, compareFit, logFitRound, MIN_FIT_IMPROVEMENT,
  type FitContext, type FitJudgeFn, type FitOutcome, type FitVerdict,
  type JudgedCompany, type JudgeUsage,
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
  /**
   * Let an employer name decide a row, in either direction, without paying for a lookup.
   * ON by default. A name with no clear signal is always researched.
   *
   * The name-decided rows are NEVER mixed into the researched figure: both are reported and
   * the round falls back to researching everything when they disagree by more than the
   * judge's own variation. See name-signal.ts.
   */
  useNameSignal?: boolean
  nameSignal?: NameSignalFn
  now?: () => number
  random?: () => number
}

export interface RoundReport {
  index: number
  kind: 'zero' | 'adjust'
  reachable: number
  ceiling: number | null
  /**
   * AMONG RESEARCHED ROWS ONLY. This is what the loop compares between rounds, because it is
   * the only figure measured the same way whether or not names were trusted.
   */
  fit: FitOutcome | null
  /**
   * INCLUDING NAME-DECIDED ROWS. Reported beside `fit`, never instead of it, and never the
   * basis of a decision. Equal to `fit` when the round fell back to researching everything.
   */
  fitIncludingNameDecided: FitOutcome | null
  nameSignal: RoundNameSignal | null
  judged: JudgedCompany[] | null
  changeDescription: string | null
  comparisonNote: string | null
  audienceNote: string | null
  billableSearches: number
  modelCalls: number
  providerCalls: number
  /** How the round spent, so the saving is visible per round and not only per run. */
  cost: RoundCost | null
}

/**
 * What a round bought and what it declined to buy.
 *
 * `lookupsSkipped` is the whole point of the two-pass shape: rows the judge settled from the
 * name alone, which under the previous shape were researched anyway at full price.
 */
/** What the employer names did this round, and whether they were believed. */
export interface RoundNameSignal {
  /** Rows whose verdict came from the name. Zero when the round fell back. */
  decided: number
  /** What the names decided BEFORE the reliability check, so a fallback is legible. */
  decidedBeforeFallback: number
  researched: number
  fellBackToResearchingEverything: boolean
  verdict: NameSignalVerdict
}

export interface RoundCost {
  sampled: number
  lookupsSkipped: number
  /** Of those skipped, how many an employer NAME decided, in either direction. */
  nameDecided: number
  lookupsMade: number
  /** Of the lookups made, how many the provider answered in a single billable search. */
  answeredInOneSearch: number
  inputTokens: number
  outputTokens: number
  usd: number
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
    useNameSignal = true,
    nameSignal = anthropicNameSignal,
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
    fit: null, fitIncludingNameDecided: null, nameSignal: null,
    judged: null, changeDescription: null, comparisonNote: null,
    audienceNote: null,
    // ASSERTED, not assumed. Round zero is free by construction.
    billableSearches: 0, modelCalls: 0, providerCalls: provider.calls,
    // Null rather than a row of zeros: this round did not decline to buy anything, it had
    // nothing to buy. A zeroed cost row would read as a round that skipped every lookup.
    cost: null,
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
        useNameSignal, nameSignal,
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

/**
 * EXPORTED AS A TEST SEAM, and for one specific proof.
 *
 * The reliability fallback has to be shown FIRING, not merely shown to be computable: a
 * predicate that returns false proves nothing about whether the round acts on it. Driving a
 * whole run to reach it would need a database, a provider and three models, so the round
 * itself is the seam. Nothing outside this module calls it in production.
 */
export async function runOneRound(ctx: {
  index: number
  request: Record<string, unknown>
  provider: ProviderBudget
  spend: SpendBudget
  lookups: LookupBudget
  sampleSize: number
  context: FitContext
  fitJudge: FitJudgeFn
  random: () => number
  useNameSignal: boolean
  nameSignal: NameSignalFn
}): Promise<RoundReport> {
  const callsBefore = ctx.provider.calls
  const searchesBefore = ctx.spend.billableSearches

  const sample = await drawSpreadSample(ctx.request, ctx.provider, ctx.sampleSize, ctx.random)

  // ─── PASS ONE. WHAT THE NAME SAYS, IF ANYTHING. ────────────────────────────
  //
  // Names decide in EITHER direction. A name with no clear signal is researched, and that is
  // expected to be most of them.
  //
  // THE TWO FIGURES ARE NEVER ADDED TOGETHER. The moment a name-derived verdict is counted
  // alongside a researched one, the number coming out measures our assumptions about names
  // rather than the search. So the round computes both separately and reports both, and when
  // they disagree by more than the judge's own variation it says the names cannot be trusted
  // for this client and researches everything. See name-signal.ts.
  //
  // THE JUDGE IS UNTOUCHED. This runs before it and changes which rows reach it. Its prompt,
  // its four verdicts and how it decides are exactly as they were.
  const signal: { decisions: NameSignalDecision[]; modelCalls: number; usage?: JudgeUsage } =
    ctx.useNameSignal
      ? await ctx.nameSignal(sample.rows, ctx.context)
      : { decisions: [], modelCalls: 0, usage: undefined }
  let modelCalls = signal.modelCalls
  const decidedById = new Map(
    signal.decisions.filter(d => isDecided(d.answer)).map(d => [d.sourceId, d]),
  )

  // ─── PASS TWO. RESEARCH EVERYTHING THE NAME DID NOT SETTLE. ────────────────
  const research = async (rows: typeof sample.rows) => {
    const results = await lookUpMany(rows.map(r => r.companyName), ctx.lookups)
    let answeredInOne = 0
    const out = rows.map((row, i) => {
      const result = results[i]
      const billable = result?.billableSearches ?? 0
      if (result && billable === 1 && !result.limited) answeredInOne += 1
      ctx.spend.record(billable, result?.inputTokens ?? 0, result?.outputTokens ?? 0, result?.model ?? null)
      return { ...row, researchText: lookupIsUsable(result) ? result!.text : null, billable }
    })
    return { out, results, answeredInOne }
  }

  const unclear = sample.rows.filter(r => !decidedById.has(r.sourceId))
  let pass = await research(unclear)
  let researched = pass.out
  let allResults = pass.results
  let answeredInOneSearch = pass.answeredInOne

  const judgeRows = async (rows: typeof researched) => {
    if (!rows.length) return { verdicts: [], modelCalls: 0, usage: undefined as JudgeUsage | undefined }
    const r = await ctx.fitJudge(rows, ctx.context)
    return { verdicts: r.verdicts, modelCalls: r.modelCalls, usage: r.usage }
  }

  let judgePass = await judgeRows(researched)
  modelCalls += judgePass.modelCalls
  const judgeUsages: (JudgeUsage | undefined)[] = [signal.usage, judgePass.usage]

  const asJudged = (rows: typeof researched, verdicts: { sourceId: string; verdict: FitVerdict; reason: string }[]): JudgedCompany[] => {
    const byId = new Map(verdicts.map(v => [v.sourceId, v]))
    return rows.map(r => ({
      sourceId: r.sourceId, jobTitle: r.jobTitle, companyName: r.companyName,
      verdict: byId.get(r.sourceId)?.verdict ?? 'cannot_establish',
      reason: byId.get(r.sourceId)?.reason ?? 'No answer returned for this row.',
      researchText: r.researchText,
      billableSearches: r.billable,
    }))
  }

  const fromName = (d: NameSignalDecision, row: { sourceId: string; jobTitle: string | null; companyName: string | null }): JudgedCompany => ({
    sourceId: row.sourceId, jobTitle: row.jobTitle, companyName: row.companyName,
    // The name's own answer, and it is only ever one of the three deciding values: the map
    // this came from was filtered on isDecided, so 'unclear' cannot reach here.
    verdict: d.answer as FitVerdict,
    reason: `Decided from the employer name, without research: ${d.reason}`,
    // Null because nothing was read. A reader disagreeing with this row is disagreeing with
    // a reading of the name, and the empty field is what tells them so.
    researchText: null,
    billableSearches: 0,
  })

  // ─── THE TWO FIGURES. SEPARATE, ALWAYS, AND NEITHER IS THE ROUND ON ITS OWN. ──
  let researchedJudged = asJudged(researched, judgePass.verdicts)
  const nameJudged = sample.rows
    .filter(r => decidedById.has(r.sourceId))
    .map(r => fromName(decidedById.get(r.sourceId)!, r))

  let fitResearched = assessFit(researchedJudged)
  let fitIncludingNames = assessFit([...researchedJudged, ...nameJudged])

  // ─── THE FLOOR IS MEASURED HERE, NOT BORROWED ─────────────────────────────
  //
  // By judging the SAME researched rows a second time. MIN_FIT_IMPROVEMENT is a draw-to-draw
  // figure and is mostly sampling noise; this comparison does no sampling, so the only
  // variation that belongs in it is the judge's own. Using the wrong one passed both live
  // clients on 2026-09-09 when both should have failed. See name-signal.ts.
  //
  // The extra call is only made when there is something to validate: no name decided
  // anything means there is nothing to compare and nothing to measure a floor for.
  let judgeNoise = MIN_FIT_IMPROVEMENT
  if (nameJudged.length > 0) {
    const again = await judgeRows(researched)
    modelCalls += again.modelCalls
    judgeUsages.push(again.usage)
    const rerun = assessFit(asJudged(researched, again.verdicts))
    const a = fitResearched.fitOfResolved
    const b = rerun.fitOfResolved
    judgeNoise = a !== null && b !== null
      ? Math.max(Math.abs(a - b), oneVerdictWorth(fitResearched.resolved))
      // No rate on one side, so the variation could not be measured. checkNameSignal will
      // refuse the comparison for the same reason a moment later; this value is not used.
      : MIN_FIT_IMPROVEMENT
  }

  let nameVerdict = checkNameSignal(
    fitResearched, fitIncludingNames, nameJudged.length, judgeNoise,
  )
  logNameSignal(sample.rows.length, nameJudged.length, nameVerdict)

  // ─── THE FALLBACK. WHEN THE NAMES DISAGREE, PAY FOR ALL OF THEM. ───────────
  //
  // This costs MORE than never gating, because the name call has already been made and now
  // every lookup is bought anyway. That is the correct trade: the alternative is a cheaper
  // number that is quietly wrong, and this module exists to measure rather than to save.
  let fellBack = false
  if (!nameVerdict.reliable && nameJudged.length > 0) {
    fellBack = true
    const late = await research(sample.rows.filter(r => decidedById.has(r.sourceId)))
    answeredInOneSearch += late.answeredInOne
    allResults = [...allResults, ...late.results]
    researched = [...researched, ...late.out]
    const lateJudge = await judgeRows(late.out)
    modelCalls += lateJudge.modelCalls
    judgeUsages.push(lateJudge.usage)
    researchedJudged = [...researchedJudged, ...asJudged(late.out, lateJudge.verdicts)]
    // Both figures are recomputed and both now cover every row, so they are equal by
    // construction. They are still reported as two, because a reader must be able to see
    // that the fallback happened rather than infer it from them matching.
    fitResearched = assessFit(researchedJudged)
    fitIncludingNames = fitResearched
  }

  const judged: JudgedCompany[] = fellBack
    ? researchedJudged
    : [...researchedJudged, ...nameJudged]

  const results = allResults
  // WHAT THE LOOP COMPARES ON IS THE RESEARCHED FIGURE, always, whether or not the names
  // were trusted. It is the only one measured the same way in every round, so it is the only
  // one two rounds can be compared with. The combined figure is reported beside it and is
  // never the basis of a decision to accept or reject a candidate search.
  const fit = fitResearched
  logFitRound(fit)

  // Summed from the results the provider actually filled, rather than reconstructed by index
  // afterwards. A null entry is a lookup the ceiling refused and costs nothing.
  const roundTokens = results.reduce(
    (a, r) => ({ in: a.in + (r?.inputTokens ?? 0), out: a.out + (r?.outputTokens ?? 0) }),
    { in: 0, out: 0 },
  )
  const roundSearches = results.reduce((a, r) => a + (r?.billableSearches ?? 0), 0)
  const roundModel = results.find(r => r?.model)?.model ?? null

  // The name call and every judging pass. Counted separately from the lookups because they
  // are billed at different rates, and summing before pricing would apply one rate to both.
  const judgeUsd = judgeUsages.reduce(
    (a, u) => a + (u ? tokenCost(u.model, u.inputTokens, u.outputTokens) : 0), 0,
  )

  const roundCost: RoundCost = {
    sampled: sample.rows.length,
    lookupsSkipped: sample.rows.length - researched.length,
    nameDecided: fellBack ? 0 : nameJudged.length,
    lookupsMade: researched.length,
    answeredInOneSearch,
    inputTokens: roundTokens.in,
    outputTokens: roundTokens.out,
    usd: roundSearches * PRICE_PER_BILLABLE_SEARCH
      + tokenCost(roundModel, roundTokens.in, roundTokens.out)
      + judgeUsd,
  }

  // SPEND AS IT GOES, not only at the end. A round is the smallest unit that can be reported
  // without the number moving while it is being read.
  logger.info('tuner: round spend', {
    round: ctx.index,
    sampled: roundCost.sampled,
    name_decided: roundCost.nameDecided,
    lookups_made: roundCost.lookupsMade,
    answered_in_one_search: roundCost.answeredInOneSearch,
    fell_back_to_researching_everything: fellBack,
    round_usd: roundCost.usd,
    run_so_far: ctx.lookups.describe(),
  })

  return {
    index: ctx.index, kind: 'adjust', reachable: sample.total, ceiling: null,
    fit, judged, changeDescription: null, comparisonNote: null, audienceNote: null,
    // TWO FIGURES, ALWAYS. Never one number: see name-signal.ts for why adding them would
    // mean measuring our assumptions about names instead of measuring the search.
    fitIncludingNameDecided: fitIncludingNames,
    nameSignal: {
      decided: fellBack ? 0 : nameJudged.length,
      decidedBeforeFallback: nameJudged.length,
      researched: researched.length,
      fellBackToResearchingEverything: fellBack,
      verdict: nameVerdict,
    },
    billableSearches: ctx.spend.billableSearches - searchesBefore,
    modelCalls,
    providerCalls: ctx.provider.calls - callsBefore,
    cost: roundCost,
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

