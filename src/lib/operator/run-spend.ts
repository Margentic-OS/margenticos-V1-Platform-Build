// One spend cap for every paid run started from the command line.
//
// ── THE RULE THIS HOLDS ──────────────────────────────────────────────────────
//
// The operator's rule: "Spend rules: cap per run (default $3)." A run that calls a paid
// API stops itself before it can spend more than a cap. The cap is 3 US dollars unless the
// run is started with --max-usd, and a run that was not told anything still has one.
//
// Before this, four scripts each bounded themselves in their own unit (a count of
// extractions, a count of prospects, a count of model questions, a number of seconds) and
// none in dollars. A count is a cap only for someone who knows the price of one, and the
// price is the part that moves.
//
// ── WHAT IS HERE, AND WHAT IS NOT ────────────────────────────────────────────
//
// Arithmetic only. No database, no model call, no reading of process.argv or the
// environment: the caller passes in what it read. That is what lets the cap be tested
// without a run, which matters because nobody can test it WITH one: a run costs money.
//
// It holds no price table of its own. Each script already prices its own calls, and the
// one shared table is src/lib/agents/research/cost-constants.ts. A second table here would
// be a second thing to keep in step. researchFetchWorstCaseUsd reads that table, and is
// handed the figures the research script owns.
//
// Deterministic code, no model (ADR-018).

import {
  COST_WEB_SEARCH_PER_SEARCH,
  RESEARCH_SONNET_MODEL,
  USD_PER_MTOK,
  usdForTokens,
} from '@/lib/agents/research/cost-constants'

/** What a run may spend when nobody said otherwise, in US dollars. */
export const DEFAULT_RUN_CAP_USD = 3

/**
 * Sums of dollars are sums of floats: 0.1 + 0.2 is 0.30000000000000004. Without this a run
 * whose spend lands exactly on its cap would be refused for a difference nobody can be
 * billed. A billionth of a dollar, so it can never admit a real overspend.
 */
const FLOAT_SLACK_USD = 1e-9

/** Dollars as a person reads them. Small amounts keep four places so they do not read as zero. */
function dollars(usd: number): string {
  return usd === 0 || usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`
}

/**
 * The cap, from the value typed after --max-usd.
 *
 * Nothing typed is the default. ANYTHING ELSE THAT IS NOT A PLAIN POSITIVE NUMBER THROWS,
 * and never falls back to the default: a person who typed a cap and got a different one
 * has been told nothing, and the direction it fails in is the expensive one whenever the
 * cap they meant was lower than 3.
 */
export function parseCapUsd(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_RUN_CAP_USD
  // A plain decimal and nothing else. Number() alone would read "" as 0, "0x10" as 16 and
  // "1e3" as 1000, none of which is what somebody typing a dollar amount meant.
  const usd = /^\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN
  if (!Number.isFinite(usd) || usd <= 0) {
    throw new Error(
      `--max-usd must be a number of US dollars greater than zero, such as 3 or 0.50. Got "${raw}". ` +
      `Leave the flag off for the default of ${dollars(DEFAULT_RUN_CAP_USD)}.`,
    )
  }
  return usd
}

/**
 * What one run has spent against its cap.
 *
 * The caller adds each cost as it learns it and asks, before each paid step, whether the
 * cap can cover the WORST case of that step. Worst case, not typical: the question is
 * asked before the money is spent, and the answer has to hold whatever the step turns out
 * to cost.
 */
export class RunSpend {
  private spentUsd = 0

  constructor(readonly capUsd: number = DEFAULT_RUN_CAP_USD) {
    if (!Number.isFinite(capUsd) || capUsd <= 0) {
      throw new Error(`A spend cap must be a number of dollars greater than zero, got ${capUsd}.`)
    }
  }

  /**
   * Record money that has been spent.
   *
   * A cost that is not a number means the meter has gone blind, and a negative one would
   * hand the run its budget back. Both throw. Adding either quietly would leave a total
   * that looks like a measurement and is not one.
   */
  add(usd: number): void {
    if (!Number.isFinite(usd) || usd < 0) {
      throw new Error(`A cost must be a number of dollars, zero or more, got ${usd}. The spend total cannot be trusted past this point.`)
    }
    this.spentUsd += usd
  }

  get spent(): number {
    return this.spentUsd
  }

  /** What is left under the cap. Never negative: a run that overshot has nothing left, not a debt. */
  get remaining(): number {
    return Math.max(0, this.capUsd - this.spentUsd)
  }

  /**
   * Can the cap cover one more step that costs at most this much?
   *
   * True when what is spent plus the worst case stays at or under the cap. A worst case
   * that is not a number answers false, so an unknown price stops the run instead of
   * letting it through.
   */
  canAfford(nextWorstCaseUsd: number): boolean {
    return this.spentUsd + nextWorstCaseUsd <= this.capUsd + FLOAT_SLACK_USD
  }

  /**
   * How many more steps the cap can cover when each costs at most this much. For a run
   * that cannot stop between steps and has to be handed a count before it starts.
   */
  affordableCount(worstCaseEachUsd: number): number {
    if (!Number.isFinite(worstCaseEachUsd) || worstCaseEachUsd <= 0) {
      throw new Error(`A worst case per step must be a number of dollars greater than zero, got ${worstCaseEachUsd}.`)
    }
    return Math.floor((this.remaining + FLOAT_SLACK_USD) / worstCaseEachUsd)
  }

  /** "$0.72 of a $3.00 cap". */
  summary(): string {
    return `${dollars(this.spentUsd)} of a ${dollars(this.capUsd)} cap`
  }
}

// ─── A flag written in the form the script does not read ─────────────────────

/** How a script reads a flag that takes a value: `--limit=10` or `--limit 10`. */
export type ValueFlagForm = 'equals' | 'space'

/**
 * Flags that take a value and were typed in a form this script does not read. One plain
 * sentence each, naming the form to use. Empty when every one is readable.
 *
 * WHY THIS IS A SPEND CONTROL AND LIVES HERE. The scripts do not agree on a form: some
 * read `--limit=10` and some read `--limit 10`. The form a script does not read is not an
 * error to it. It is simply not there, so the run proceeds as if the flag had never been
 * typed. For a limit that means NO limit, and for a cap it means a different cap. Read in
 * scripts/backfill-followups.ts on 2026-10-02 (from the code, not from a run): it looked
 * for an argument starting `--limit=`, so `--limit 10` matched nothing and the writer was
 * run for the whole cohort. A bound that can be switched off by a space is not a bound.
 *
 * `valueFlags` are names without the dashes. Only those names are looked at, so a flag
 * that takes no value (--commit) is never mistaken for one.
 */
export function valueFlagProblems(
  argv: readonly string[],
  valueFlags: readonly string[],
  form: ValueFlagForm,
): string[] {
  const problems: string[] = []
  for (const [i, given] of argv.entries()) {
    for (const name of valueFlags) {
      const flag = `--${name}`
      const next = argv[i + 1]
      const nextIsAValue = next !== undefined && !next.startsWith('--')
      if (form === 'equals') {
        if (given === flag) {
          problems.push(`${flag} is read only with an equals sign and no space. Write ${flag}=${nextIsAValue ? next : '<value>'}`)
        } else if (given === `${flag}=`) {
          problems.push(`${flag}= has no value after the equals sign. Write ${flag}=<value>, or leave the flag off`)
        }
      } else if (given.startsWith(`${flag}=`)) {
        problems.push(`${given} is not read: this script takes a space, not an equals sign. Write ${flag} ${given.slice(flag.length + 1) || '<value>'}`)
      } else if (given === flag && !nextIsAValue) {
        problems.push(`${flag} has no value after it. Write ${flag} <value>, or leave the flag off`)
      }
    }
  }
  return problems
}

// ─── A count typed after --limit ─────────────────────────────────────────────

/**
 * How many, from the value typed after --limit. Nothing typed is null, and the caller
 * applies its own default.
 *
 * ANYTHING ELSE THAT IS NOT A WHOLE NUMBER GREATER THAN ZERO THROWS, and never comes back
 * as "no limit". Each script used to read it with Number(), and each wrong value switched
 * the limit off or to nothing without a word (read from the code on 2026-10-02, not from
 * a run): "abc" is NaN and `attempted >= NaN` is never true, so the run had no count limit
 * at all; "0" is falsy where a limit was tested for truth, so it also meant none; "2.5"
 * cut a list at two. The dollar cap still held in every case. A limit somebody typed and
 * did not get is the same fault as a cap somebody typed and did not get: see parseCapUsd.
 */
export function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const count = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new Error(
      `--limit must be a whole number greater than zero, such as 10. Got "${raw}". ` +
      'Leave the flag off for this script\'s default.',
    )
  }
  return count
}

// ─── What one prospect can cost a research run that fetches every source ─────

/**
 * How many synthesis answers one prospect can be billed for. A synthesis answer cut off at
 * the output ceiling is asked for again ONCE, and both are billed (ADR-059).
 */
const SYNTHESES_BILLED_AT_WORST = 2

/** Up to the next ten cents: 0.83 is 0.90, and 0.20 stays 0.20. */
function upToTenCents(usd: number): number {
  return Math.ceil((usd - FLOAT_SLACK_USD) * 10) / 10
}

/**
 * The worst case for ONE prospect in a research run that fetches every source, in dollars,
 * for the check scripts/run-research.ts makes before it spends anything.
 *
 * COMPUTED FROM THE OUTPUT CEILING, THE INPUT SIZES AND THE PRICE TABLE, so it moves when
 * any of them does:
 *
 *     what the script prices beside synthesis   (passed in: the script owns those figures)
 *   + 2 x the synthesis output ceiling, at the research model's FULL output price
 *   + 2 x one synthesis's input on a COLD cache: the system prefix at the cache-WRITE rate,
 *         the prospect's own part at the input rate
 *     rounded up to the next ten cents
 *
 * WHY TWO, AND WHY THE CEILING. Synthesis is where the money is, and its worst case is not
 * an average answer. An answer that reaches the output ceiling has lost its JSON, is
 * retried once, and the retry can reach the ceiling too. Each is billed for a full ceiling
 * of output. Until 2026-10-02 the script held a fixed $0.50 and priced the discarded
 * answer as one more AVERAGE synthesis, about $0.18. A ceiling of 24,000 tokens at $15 a
 * million is $0.36, so a prospect that truncated once cost about $0.65 and one whose
 * retry truncated too about $0.83, against a "worst case" of $0.50: six such prospects
 * were admitted under a $3 cap and could cost $3.90 to $4.98.
 *
 * WHY A COLD CACHE (the second fix round, 2026-10-02). The first version left the input
 * side to the rounding, on the reasoning that a cached prefix costs under a cent an answer.
 * That holds only for a WARM cache. A 24,000-token answer can stream for longer than the
 * cache's five-minute life, so the retry may write the prefix again, and the first answer
 * of a run always writes it. Cold, one synthesis's input is about four cents at the
 * script's figures (8,500 prefix tokens at $3.75 a million, 3,000 others at $3), and two
 * of them took the total to $0.91, over the $0.90 it was then rounded to. Priced in, it is
 * $1.00, and the default $3 cap still admits three fetching prospects.
 *
 * FULL PRICE, though a queued run's synthesis is billed at half on the Batch API. The
 * command line can run inline at full price, and over-stating the queued run is the
 * direction a spend guard has to err.
 *
 * `synthesisMaxOutputTokens` and the two input sizes are passed in, not imported: the
 * ceiling lives in synthesize.ts, and importing that here would pull the whole research
 * pipeline into a file that is arithmetic and nothing else. The input sizes are the
 * script's own stated figures, each with where it comes from.
 */
export function researchFetchWorstCaseUsd(input: {
  /** Everything the script prices for a fetching prospect except synthesis, in dollars. */
  otherThanSynthesisUsd: number
  /** SYNTHESIS_MAX_OUTPUT_TOKENS: the most output one synthesis answer can be billed for. */
  synthesisMaxOutputTokens: number
  /** The cached system prefix of one synthesis request, in tokens. Priced at the cache-write rate. */
  synthesisSystemPrefixTokens: number
  /** The rest of one synthesis request's input (the prospect's own sources), in tokens. */
  synthesisUserTokens: number
}): number {
  const { otherThanSynthesisUsd, synthesisMaxOutputTokens, synthesisSystemPrefixTokens, synthesisUserTokens } = input
  if (!Number.isFinite(synthesisMaxOutputTokens) || synthesisMaxOutputTokens <= 0) {
    throw new Error(`The synthesis output ceiling must be a number of tokens greater than zero, got ${synthesisMaxOutputTokens}.`)
  }
  if (!Number.isFinite(otherThanSynthesisUsd) || otherThanSynthesisUsd < 0) {
    throw new Error(`What a prospect costs beside synthesis must be a number of dollars, zero or more, got ${otherThanSynthesisUsd}.`)
  }
  for (const [name, count] of [['system prefix', synthesisSystemPrefixTokens], ['user part', synthesisUserTokens]] as const) {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`The synthesis ${name} must be a whole number of input tokens, zero or more, got ${count}.`)
    }
  }
  // No price is no worst case. Thrown, never priced at nothing: the caller is a spend guard.
  const rate = USD_PER_MTOK[RESEARCH_SONNET_MODEL]
  if (!rate) throw new Error(`No price on record for ${RESEARCH_SONNET_MODEL}: the research worst case cannot be worked out.`)
  const oneSynthesisAtTheCeilingUsd = (synthesisMaxOutputTokens * rate.output) / 1_000_000
  const oneSynthesisInputColdUsd = (synthesisSystemPrefixTokens * rate.cacheWrite + synthesisUserTokens * rate.input) / 1_000_000
  return upToTenCents(otherThanSynthesisUsd + SYNTHESES_BILLED_AT_WORST * (oneSynthesisAtTheCeilingUsd + oneSynthesisInputColdUsd))
}

// ─── What a research run actually spent, from the usage ledger ───────────────

/** The columns of a research_usage row that carry spend. */
export interface ResearchUsageRow {
  synthesis?: unknown
  opening?: unknown
  followups?: unknown
  web_search?: unknown
  synthesis_batched?: unknown
  firm_fact?: unknown
}

type Tokens = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

/** A stage's token counts, or null when the value is not one. The cache counts are optional. */
function tokens(value: unknown): Tokens | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const count = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null)
  const input = count(v.input_tokens)
  const output = count(v.output_tokens)
  if (input === null || output === null) return null
  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: count(v.cache_creation_input_tokens) ?? 0,
    cache_read_input_tokens: count(v.cache_read_input_tokens) ?? 0,
  }
}

/**
 * What one research_usage row cost, in dollars at today's rates. NULL WHEN THE ROW CANNOT
 * BE PRICED, never zero: a row this cannot read spent something, and counting it as
 * nothing is how a total comes to look complete when it is not.
 *
 * The table stores token counts and no price, on purpose (its own comment: "Priced, never
 * storing a price"), so the price is applied here from the shared table:
 *
 *   a research row    synthesis, opening and follow-ups at the research model's rate,
 *                     synthesis at half when it went through the Batch API, plus the web
 *                     search call at its own model's rate and one fee per billable search.
 *   a firm-fact row   the dollar figure the extraction step computed and stored beside
 *                     its usage. The other columns on that row are zeros by construction.
 *
 * NOT IN THE LEDGER, so not in this figure: the profile-posts fetch (a ceiling of about a
 * cent a prospect, see COST_APIFY), the competitor check, and whatever a prospect that
 * FAILED spent before it stopped, because a failed prospect writes no row.
 */
export function researchUsageRowUsd(row: ResearchUsageRow): number | null {
  if (row.firm_fact !== null && row.firm_fact !== undefined) {
    const cost = (row.firm_fact as { cost_usd_full_price?: unknown }).cost_usd_full_price
    return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null
  }

  const synthesis = tokens(row.synthesis)
  const opening = tokens(row.opening)
  // NULL follow-ups is a fact, not a gap: no follow-up call was paid for.
  const followups = row.followups === null || row.followups === undefined ? null : tokens(row.followups)
  const webSearch = tokens(row.web_search)
  if (!synthesis || !opening || !webSearch) return null
  if (row.followups !== null && row.followups !== undefined && !followups) return null

  const search = row.web_search as { model?: unknown; search_count?: unknown }
  const searches = typeof search.search_count === 'number' && Number.isFinite(search.search_count) ? search.search_count : null
  if (searches === null) return null

  return (
      usdForTokens(synthesis, RESEARCH_SONNET_MODEL) * (row.synthesis_batched === true ? 0.5 : 1)
    + usdForTokens(opening, RESEARCH_SONNET_MODEL)
    + (followups ? usdForTokens(followups, RESEARCH_SONNET_MODEL) : 0)
    // An unrecorded model is priced at the dearest rate by usdForTokens, never at zero.
    + usdForTokens(webSearch, typeof search.model === 'string' ? search.model : null)
    + searches * COST_WEB_SEARCH_PER_SEARCH
  )
}
