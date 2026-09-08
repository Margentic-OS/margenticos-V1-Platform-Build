// Round zero: everything that is free, before anything that is not.
//
// ─── WHY THE ORDER IS THE DESIGN ─────────────────────────────────────────────
//
// Counting is free. Differencing is free. Reading the client's document is free. A model
// call costs roughly twenty seconds of a two-hundred-and-forty second budget, and a web
// lookup costs money.
//
// So every free question is asked first, and the expensive ones happen only if the free
// answers say there is something worth tuning. That ordering is not an optimisation; it is
// the difference between a tuner that can tell you an audience does not exist and one that
// spends a round discovering it.
//
// MEASURED 2026-09-08, one live organisation reaches a terminal state here with a
// population of ONE and a relaxation ceiling of 879. Every fact needed to say so is free.
// A loop that sampled and judged first would have made a model call to judge a sample of one
// row and learned nothing it did not already know.
//
// ─── THE TWO POPULATION FIGURES, AND WHY BOTH ARE ALWAYS REPORTED ────────────
//
// A small population has two causes that the count alone cannot separate: the search is too
// tight, or the audience does not exist. The ceiling — the same query with the buyer
// constraints relaxed — is what separates them, and it is reported on every run whether or
// not it changes the outcome, so an operator never has to infer which case they are in.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { buildApolloRequest, ALL_TARGETABLE_NAICS_CODES } from '@/lib/sourcing/handlers/adapter-apollo'
import { countAndSample, type ProviderBudget } from '@/lib/tuner/count-and-sample'
import { differenceSearch } from '@/lib/tuner/differencing'
import { countTiers } from '@/lib/tuner/tier-counts'
import { measureCeiling, type Ceiling } from '@/lib/tuner/relaxation-ceiling'
import { readUnresolvedFields, describeBlockingFields } from '@/lib/tuner/unresolved-fields'
import { MIN_RESOLVED_SAMPLE } from '@/lib/tuner/judge'
import type {
  DifferencingResult, TerminalState, TierCounts, UnresolvedFieldFinding,
} from '@/lib/tuner/types'

/**
 * The smallest population that can produce a judgeable sample.
 *
 * DERIVED FROM THE JUDGE'S OWN FLOOR, not chosen. The judge refuses to report an agreement
 * figure below MIN_RESOLVED_SAMPLE resolved answers, so a population smaller than that
 * cannot yield one however it is sampled. Calling a model on it would spend the run's most
 * expensive step to learn nothing, which is precisely the ordering mistake this module
 * exists to prevent.
 *
 * Writing it as a derivation rather than a number means lowering the judge's floor cannot
 * silently leave this one stranded above it.
 */
export const MIN_JUDGEABLE_POPULATION = MIN_RESOLVED_SAMPLE

/**
 * How much bigger an alternative bucket must be before the taxonomy is the problem.
 *
 * JUDGEMENT. Used only when the ceiling is already below the judgeable floor: at that point
 * the question is whether ANY bucket in the taxonomy would have found this client's market.
 * Ten times a population that is already tiny is still a small number, which is the point —
 * the test is "is there something meaningfully better", not "is there something enormous".
 */
export const TAXONOMY_ALTERNATIVE_RATIO = 10

/** What a client's contract requires, if anyone has said. There is no default. */
export interface ContractRequirement {
  monthlyProspects: number
  months: number
}

export interface RoundZeroInput {
  supabase: SupabaseClient
  organisationId: string
  spec: Record<string, unknown>
  icpContent: Record<string, unknown>
  budget: ProviderBudget
  /**
   * REQUIRED TO REACH `population_too_small_for_contract`, AND THERE IS NO DEFAULT.
   *
   * A client's monthly prospect volume is not stored anywhere on the organisation record —
   * `monthly_meetings_target` is a meetings figure and not this — and the project's own
   * documents carry at least four different monthly figures that disagree with each other by
   * up to a factor of three. Choosing one here would be this module deciding a commercial
   * question on the strength of whichever document it happened to read.
   *
   * So it is passed in or the state is unreachable, and round zero says which happened.
   */
  contract?: ContractRequirement
}

export interface RoundZeroResult {
  population: number
  ceiling: Ceiling
  differencing: DifferencingResult
  tierCounts: TierCounts | null
  unresolvedFields: UnresolvedFieldFinding[]
  /** Set when round zero alone settles the run. Null means it is worth tuning. */
  terminal: { state: TerminalState; reason: string } | null
  /** Free-form operator-facing notes about what was and was not measurable. */
  notes: string[]
  request: Record<string, unknown>
}

export async function runRoundZero(input: RoundZeroInput): Promise<RoundZeroResult> {
  const { spec, icpContent, budget, contract } = input
  const notes: string[] = []

  const request = buildApolloRequest(spec)

  const differencing = await differenceSearch(request, budget)
  const population = differencing.population

  const ceiling = await measureCeiling(request, budget, population)
  const tierCounts = await countTiers(spec, icpContent, budget)
  const unresolvedFields = readUnresolvedFields(icpContent)

  if (tierCounts === null) {
    notes.push(
      'Per-tier counts could not be produced: the document does not carry two tiers with ' +
      'usable industries. The combined figure is the only one available, so a tier swamping ' +
      'the other would not be visible this run.',
    )
  } else if (tierCounts.tiersDisjoint && (tierCounts.neitherTier ?? 0) > 0) {
    notes.push(
      `The two tiers share no industry, and at least ${tierCounts.neitherTier} of ` +
      `${tierCounts.combined} reachable rows (` +
      `${((tierCounts.neitherTier ?? 0) / Math.max(tierCounts.combined, 1) * 100).toFixed(1)}%) ` +
      'match neither tier. The spec merges the tiers by taking the union of their industries ' +
      'and the union of their sizes, which admits one tier\'s industries at the other tier\'s ' +
      'sizes.',
    )
  }
  if (tierCounts && tierCounts.smallerTierShare < 0.05 && tierCounts.combined > 0) {
    notes.push(
      `The smaller tier is ${(tierCounts.smallerTierShare * 100).toFixed(1)}% of the combined ` +
      'population, so a sample drawn from the combined search will rarely contain one.',
    )
  }

  notes.push(
    `Population as configured: ${population}. With the buyer constraints relaxed: ` +
    `${ceiling.ceiling}. ` +
    (ceiling.buyerConstraintsAreNotTheLimit
      ? 'Relaxing them barely moves it, so the buyer definition is not what limits this search.'
      : 'The gap between the two is what the buyer constraints are removing.'),
  )

  if (differencing.suspectedIgnoredAxes.length > 0) {
    notes.push(
      `Suspected ignored by the provider: ${differencing.suspectedIgnoredAxes.join(', ')}. ` +
      'The layer is populated, removing it changes nothing, and no member of it finds anybody ' +
      'alone. Confirm with a misspelled-parameter control before acting on it.',
    )
  }

  const terminal = await decideTerminal({
    ...input, population, ceiling, differencing, unresolvedFields, request, notes,
  })

  logger.info('tuner: round zero complete', {
    organisation_id: input.organisationId,
    population,
    ceiling: ceiling.ceiling,
    provider_calls: budget.calls,
    model_calls: 0,
    billable_searches: 0,
    terminal_state: terminal?.state ?? null,
  })

  return { population, ceiling, differencing, tierCounts, unresolvedFields, terminal, notes, request }
}

/**
 * Does round zero settle it?
 *
 * ─── THE ORDER OF THESE CHECKS IS LOAD-BEARING ───────────────────────────────
 *
 * Several can be true at once and they are not equally useful. A client whose document has
 * an unresolved field AND a tiny population should hear about the field first, because
 * measuring a population defined by a value nobody confirmed is work that has to be redone.
 * A client whose audience cannot sustain their contract should hear that rather than
 * "effectively empty", because the first is a commercial conversation and the second reads
 * as a bug.
 */
async function decideTerminal(ctx: {
  spec: Record<string, unknown>
  budget: ProviderBudget
  contract?: ContractRequirement
  population: number
  ceiling: Ceiling
  differencing: DifferencingResult
  unresolvedFields: UnresolvedFieldFinding[]
  request: Record<string, unknown>
  notes: string[]
}): Promise<{ state: TerminalState; reason: string } | null> {
  // 1. The client's own document says it does not know something the search is built from.
  const blocking = describeBlockingFields(ctx.unresolvedFields)
  if (blocking) {
    return { state: 'document_unresolved_fields_block_search', reason: blocking }
  }

  // 2. Does the taxonomy hold anything that fits this client at all?
  //
  // Only asked when the ceiling is already below the judgeable floor, because that is the
  // only situation in which the answer changes what happens next. Asking it always would
  // spend fifty provider calls on every run to confirm something the population already said.
  if (ctx.ceiling.ceiling < MIN_JUDGEABLE_POPULATION) {
    const alternative = await bestAlternativeBucket(ctx.request, ctx.budget)
    if (alternative.best <= ctx.ceiling.ceiling * TAXONOMY_ALTERNATIVE_RATIO) {
      return {
        state: 'no_taxonomy_bucket_fits',
        reason:
          `With the buyer constraints relaxed this client reaches ${ctx.ceiling.ceiling} people. ` +
          `Every one of the ${alternative.tried} classification buckets the sourcing handler can ` +
          `express was tried in place of theirs, at the same size and geography, and the best of ` +
          `them reaches ${alternative.best}. No bucket in the taxonomy describes this client's ` +
          'market, so no amount of tuning the search will help. The decision is about the ' +
          'taxonomy, not about the search.',
      }
    }
    return {
      state: 'forbidden_change_required',
      reason:
        `With the buyer constraints relaxed this client reaches ${ctx.ceiling.ceiling} people, ` +
        `while a different classification bucket would reach ${alternative.best} at the same ` +
        'size and geography. The change that would help is a change to which bucket this ' +
        'client is targeted under, and that widens past what their own document states, so the ' +
        'tuner may not propose it. It needs a decision on the document, not on the search.',
    }
  }

  // 3. Can the audience sustain the contract, even fully relaxed?
  //
  // Measured against the CEILING and not the current population, deliberately. The question
  // is whether the audience can ever be enough, not whether today's search finds enough.
  if (ctx.contract) {
    const needed = ctx.contract.monthlyProspects * ctx.contract.months
    if (ctx.ceiling.ceiling < needed) {
      return {
        state: 'population_too_small_for_contract',
        reason:
          `Serving ${ctx.contract.months} months at ${ctx.contract.monthlyProspects} prospects a ` +
          `month needs ${needed} people. With every buyer constraint relaxed this client reaches ` +
          `${ctx.ceiling.ceiling}, and as configured they reach ${ctx.population}. Tuning cannot ` +
          'close that gap because the ceiling is the whole audience. This is a commercial ' +
          'conversation, not a search problem.',
      }
    }
  } else {
    ctx.notes.push(
      'No contract requirement was supplied, so this run cannot say whether the audience is ' +
      'large enough to serve one. The monthly prospect volume is not stored on the ' +
      'organisation record and the project\'s own documents carry several figures that ' +
      'disagree, so nothing is assumed. Supply it to reach that conclusion.',
    )
  }

  // 4. Is there enough to judge?
  if (ctx.population < MIN_JUDGEABLE_POPULATION) {
    const diagnosis = ctx.ceiling.buyerConstraintsAreNotTheLimit
      ? `Relaxing every buyer constraint takes it only to ${ctx.ceiling.ceiling}, so the ` +
        'people are not there to find and the buyer definition is not what is hiding them.'
      : `With the buyer constraints relaxed the same search reaches ${ctx.ceiling.ceiling}, so ` +
        'the audience exists and this client\'s stated job titles and seniority are what ' +
        'reduce it. That is a conversation about who they sell to, which the tuner may not ' +
        'decide for them.'
    return {
      state: 'population_effectively_empty',
      reason:
        `The search reaches ${ctx.population} ${ctx.population === 1 ? 'person' : 'people'}, ` +
        `below the ${MIN_JUDGEABLE_POPULATION} needed for a sample any judge could report on. ` +
        `${diagnosis} No model call was made, because none could have produced information.`,
    }
  }

  return null
}

/**
 * The best population any single classification bucket would reach for this client.
 *
 * Substitutes each bucket the sourcing handler can express in place of the client's own,
 * holding size, geography and the buyer constraints as the document states them. Free, and
 * the only reason it is not run on every round zero is time: it is one call per bucket.
 *
 * IT PROPOSES NOTHING. Changing which bucket a client is targeted under is a statement about
 * what their business is, which lives in their document. This measures whether the taxonomy
 * has anything better so that the difference between "no bucket fits" and "a different
 * bucket fits and we may not choose it" is a number rather than an opinion.
 */
async function bestAlternativeBucket(
  request: Record<string, unknown>,
  budget: ProviderBudget,
): Promise<{ best: number; tried: number }> {
  const own = new Set(
    Array.isArray(request.organization_naics_codes)
      ? (request.organization_naics_codes as string[])
      : [],
  )

  // The buyer constraints are relaxed here for the same reason the ceiling relaxes them:
  // the question is whether the BUCKET is wrong, and leaving a narrow title list in place
  // would make every bucket look empty.
  const probe: Record<string, unknown> = { ...request }
  delete probe.person_titles
  delete probe.person_seniorities
  delete probe.q_organization_keyword_tags

  let best = 0
  let tried = 0
  for (const code of ALL_TARGETABLE_NAICS_CODES) {
    if (own.has(code)) continue
    if (budget.exhausted) break
    tried++
    const total = (await countAndSample({ ...probe, organization_naics_codes: [code] }, budget)).total
    if (total > best) best = total
  }
  return { best, tried }
}
