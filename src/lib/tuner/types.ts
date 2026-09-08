// Shared types for the sourcing tuner.
//
// ─── RULE ZERO ───────────────────────────────────────────────────────────────
//
// Nothing in this directory names an industry, a product, a sector, a country, a buyer
// type or a company, in code, comments, prompts, tests or fixtures. Every such value
// arrives at run time from one client's own stored spec and documents. Where an
// illustration is needed the placeholders are letters and indexes.

/**
 * How a tuning run ended. EVERY OUTCOME IS DISTINCT AND NAMED.
 *
 * There is deliberately no boolean and no nullable success flag anywhere in this module.
 * The only way to read the outcome is to read which of these it was, so that "we could not
 * do this" cannot be rendered by the same code path as "this is ready".
 *
 * The four that are not failures of the tuner are worth reading together, because they are
 * the answer rather than an absence of one:
 *
 *   population_too_small_for_contract   the audience exists and is too small to serve.
 *   population_effectively_empty        the search reaches essentially nobody.
 *   no_taxonomy_bucket_fits             no bucket in the taxonomy describes this client,
 *                                       so no amount of tuning helps and the decision is
 *                                       about the taxonomy, not about the search.
 *   document_unresolved_fields_block_search
 *                                       the client's own document says it does not know
 *                                       something the search depends on.
 *
 * Each of those is a finished piece of work. Tuning further would be inventing a result.
 */
export const TERMINAL_STATES = [
  'accepted',
  'population_too_small_for_contract',
  'population_effectively_empty',
  'no_taxonomy_bucket_fits',
  'document_unresolved_fields_block_search',
  'no_round_improved',
  'judge_unreliable',
  'name_signal_too_low',
  'wall_clock_exhausted',
  'lookup_budget_exhausted',
  'provider_ignored_a_parameter',
  'rate_limit_reached',
  'forbidden_change_required',
  'failed',
] as const
export type TerminalState = (typeof TERMINAL_STATES)[number]

/**
 * Which terminal states mean "there is a plan worth a person's time".
 *
 * DERIVED FROM ONE LIST rather than written as a second one, and it is a Set of exactly
 * one member today. It exists so that no caller anywhere writes `state !== 'failed'` or
 * `state.startsWith(...)` and accidentally renders a giving-up state as a success.
 */
export const STATES_WITH_A_PLAN: ReadonlySet<TerminalState> = new Set<TerminalState>(['accepted'])

/** One search parameter the tuner can reason about, named as the provider names its shape. */
export type ItemAxis =
  | 'industry_code'
  | 'search_word'
  | 'job_title'
  | 'seniority'
  | 'headcount_band'
  | 'company_country'
  | 'person_country'

/**
 * What differencing found about ONE item of a search.
 *
 * ─── WEAK AND REDUNDANT ARE DIFFERENT AND THE DIFFERENCE IS THE POINT ────────
 *
 * `alone` is how many the item finds by itself. `withoutIt` is the population when the
 * item is removed and its siblings remain.
 *
 *   WEAK       low `alone`. The item genuinely finds almost nobody. This is evidence the
 *              item is a bad choice, and it is the only signal that is.
 *   REDUNDANT  `withoutIt` equals the full population. The item's matches are entirely
 *              covered by its siblings, so removing it changes nothing. Dropping it may be
 *              correct for tidiness. IT IS NEVER EVIDENCE OF A TARGETING FAULT.
 *
 * They look identical if you only read "removing it changed nothing", which is why they
 * are two fields and never one. Measured on a live organisation 2026-09-08: a job title
 * scoring 4,068 alone whose removal moved the total by zero. Read as weak, that item gets
 * deleted and 4,068 reachable people go with it. Read as redundant, it is correctly left
 * alone or trimmed for neatness with no conclusion drawn.
 */
export interface ItemDifference {
  axis: ItemAxis
  /** Position within its own axis. Never the value: values are client vocabulary. */
  index: number
  /** Population with only this item on its axis, siblings removed. */
  alone: number
  /** Population with this item removed and its siblings kept. Null when it is the last one. */
  withoutIt: number | null
  /** True when removing it does not move the population at all. */
  redundant: boolean
  /** True when it finds fewer than the weak threshold by itself. */
  weak: boolean
  /** True when it alone accounts for at least the dominance share of the population. */
  dominant: boolean
}

/** What differencing found about one whole layer. */
export interface LayerDifference {
  axis: ItemAxis
  /** Population with the entire layer removed. */
  withoutLayer: number
  /** True when removing the whole layer does not move the population. */
  inert: boolean
}

export interface DifferencingResult {
  population: number
  layers: LayerDifference[]
  items: ItemDifference[]
  /**
   * Axes the provider appears to have ignored: the layer is populated, and removing it
   * changes nothing, and no single item in it finds anything either.
   *
   * NOT THE SAME AS AN INERT LAYER. A layer can be inert because its members genuinely
   * match everything the other constraints already select, which is a fact about this
   * client's market rather than a broken parameter. This list is the narrower case where
   * the layer looks like it was never applied.
   */
  suspectedIgnoredAxes: ItemAxis[]
}

/** One judged row. The judge sees only what the provider actually returns. */
export interface JudgedRow {
  /** Provider row identity, so a human can find it again. */
  sourceId: string
  jobTitle: string | null
  companyName: string | null
  verdict: JudgeVerdict
  reason: string
  /** Present only where a lookup was made, so a human can see what was read. */
  lookupText: string | null
  lookupBillableSearches: number
}

export type JudgeVerdict = 'fits' | 'does_not_fit' | 'cannot_tell'

/**
 * One tuning round.
 *
 * Round zero is free by construction: `modelCalls` and `billableSearches` are zero and the
 * loop asserts it. See runTuner.
 */
export interface RoundRecord {
  index: number
  kind: 'zero' | 'adjust'
  population: number | null
  differencing: DifferencingResult | null
  tierCounts: TierCounts | null
  unresolvedFields: UnresolvedFieldFinding[] | null
  changeProposed: ProposedChange | null
  changeReason: string | null
  judged: JudgedRow[] | null
  judgeResolvedSample: number | null
  judgeAgreement: number | null
  judgeReliable: boolean | null
  modelCalls: number
  billableSearches: number
  providerCalls: number
}

/** Per-tier populations, and the rows that belong to neither. */
export interface TierCounts {
  combined: number
  tierOne: number
  tierTwo: number
  /**
   * True when the two tiers share no industry at all. Only then is `neitherTier` a sound
   * lower bound, because only then is the sum of the two a disjoint sum.
   */
  tiersDisjoint: boolean
  /** Lower bound on rows matching the combined query and neither tier. Null unless disjoint. */
  neitherTier: number | null
  /** The smaller tier as a share of the combined population, so swamping is visible. */
  smallerTierShare: number
}

/** One unresolved field on the client's document that bears on the search. */
export interface UnresolvedFieldFinding {
  kind: string
  fieldPath: string
  whyUnresolved: string
  /** The document's own question, so it can be put to the client verbatim. */
  questionToSettleIt: string
  /** True when the field path is one the search is actually built from. */
  bearsOnSearch: boolean
}

/** A change the tuner proposes. It is never applied here. */
export interface ProposedChange {
  axis: ItemAxis
  action: 'drop_item' | 'add_word' | 'relax_layer'
  /** Index within the axis for a drop. Null for an add. */
  index: number | null
  /** For add_word only. Client vocabulary, derived from the client's own documents. */
  value: string | null
  /** The measurement that justified it. Prose, operator-facing. */
  evidence: string
}

/** The staleness marker. Three fields, because the document id alone does not move. */
export interface DocumentMarker {
  documentId: string
  version: string
  updatedAt: string
}
