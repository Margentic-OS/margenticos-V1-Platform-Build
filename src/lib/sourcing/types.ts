// src/lib/sourcing/types.ts
// Type definitions for the sourcing pipeline.

// IMPORTANT: research_tier vs sourced_tier are UNRELATED concepts and must never be conflated.
//
// research_tier:
//   Set by: prospect-research-agent-v2 (synthesis step)
//   Meaning: Depth of research conducted on a prospect (Tier 1 = full multi-source, Tier 2 = light, Tier 3 = minimal/none)
//   Table: prospects.research_tier or prospect_research_results columns (multiple field names for different purposes)
//   Purpose: Determines which composition path to take (full bridge + trigger vs templated)
//
// sourced_tier:
//   Set by: sourcing-orchestrator (qualification step after handler returns)
//   Meaning: Quality of match between candidate and client's ICP filter spec (Tier 1 = strict match, Tier 2 = loosened match, Tier 3 = acceptable match)
//   Table: prospects.sourced_tier
//   Purpose: Determines sending strategy and reply-handling tier (Tier 1 -> advanced handling, Tier 3 -> manual-required)
//
// They operate on different dimensions:
//   - research_tier: information confidence (how much we know)
//   - sourced_tier: specification fitness (how well they match the ICP)
//
// A prospect may have research_tier='tier_1' (deep research done) AND sourced_tier='tier_3' (poor ICP fit),
// or vice versa. Treat them independently in all downstream logic.

// Placeholder for future sourcing type definitions
// (Will expand as sourcing handlers and composition logic are built)

import type { SourcingStopReason } from '@/lib/sourcing/window-budget'

export type SourcingTriggerType = 'inventory_monitor' | 'operator_manual'

export interface SourcingRunResult {
  organisation_id: string
  trigger_type: SourcingTriggerType
  candidates_sourced: number
  candidates_qualified: number
  run_timestamp: string
  /** The batch identity every prospect this run wrote points at. NULL if the record could not be created. */
  sourcing_run_id: string | null
  error?: string

  // ── HOW FAR THE RUN GOT, AND WHY IT STOPPED ────────────────────────────────
  //
  // A sourcing run reads the provider in windows and stops when the requested batch is done,
  // when its runtime budget runs out, when the provider has no more rows, or at the provider's
  // reachable-record ceiling. All four produce a COMPLETED run with a count, so without these
  // fields "sourced 100 of 500" and "there are only 100 people" are the same answer.
  //
  // OPTIONAL, so every existing caller and test that builds a SourcingRunResult by hand still
  // compiles. The failure path leaves them unset, because a run that threw does not know which
  // of the four it would have been.

  /** Provider windows this run completed. */
  windows_processed?: number
  /** Provider records this run consumed, summed over its windows. The cursor advanced by this. */
  records_consumed?: number
  /** Requested records this run never reached. Another press picks these up. */
  records_remaining?: number
  /** Which of the four endings this was. See SourcingStopReason. */
  stop_reason?: SourcingStopReason
  /** The one sentence an operator reads. Built by describeStop, in one place. */
  stop_message?: string
}

export interface SourcingHandler {
  name: string
  supported_fields: string[]

  // The canonical industries this handler's query actually targets.
  //
  // REQUIRED, not optional, and that is the point. A handler cannot be added
  // without saying what it goes looking for, so the orchestrator's pre-search
  // gate can never be handed `undefined` and quietly pass. Optional here would
  // mean a new handler skips the gate by omission, which is the silent-default
  // shape this field exists to close.
  //
  // Canonical names only (CANONICAL_INDUSTRIES in icp-filter-spec.ts), never a
  // tool's own taxonomy, so it compares directly against ICPFilterSpec.industries.
  //
  // A future spec-driven handler, whose query IS the spec and therefore targets
  // whatever it is asked for, does not fit this shape. That is deliberately not
  // modelled yet: nothing needs it, and the type will force whoever builds it to
  // say so out loud rather than default their way past the gate.
  targeted_industries: readonly string[]

  // The ISO-3166 alpha-2 country codes this handler's query can actually target.
  //
  // REQUIRED for the same reason targeted_industries is. The ICP filter spec derivation
  // reads this before writing a country into a spec, so that a client document naming a
  // country the handler cannot reach fails at the document that caused it rather than at
  // a sourcing run days later. Optional here would mean a new handler skips that check by
  // omission.
  //
  // WHAT IT IS NOT. This is a statement of REACH, not of permission. A code appearing
  // here says the handler knows how to ask its provider for that country; it says nothing
  // about whether that country is lawful to contact. Exclusions are applied separately
  // and earlier, in geography-exclusion.ts, and the handler keeps its own refusal as a
  // backstop. A handler must therefore advertise every country it can translate,
  // including ones that are excluded, or the two mechanisms would be describing each
  // other instead of the world.
  //
  // Canonical ISO-2 only, never a provider's own place names, so it compares directly
  // against ICPFilterSpec.person_countries and company_countries.
  targetable_countries: readonly string[]

  adapter: (spec: unknown) => unknown

  /**
   * Run the search and report how far through the result set it got.
   *
   * `startOffset` is a 0-based record position to resume from, so a run picks up where this
   * client's previous run stopped instead of re-reading the top of the same result set. See
   * src/lib/sourcing/record-position.ts.
   *
   * IT RETURNS A RESULT OBJECT, NOT A BARE ARRAY, and that is load-bearing. The caller has to
   * advance the cursor by the number of records READ, and that number is not recoverable
   * from the candidate list: handlers post-filter, so candidates.length is smaller than the
   * window consumed. A cursor advanced by candidates.length would re-read every dropped
   * record on every later run.
   *
   * Typed here rather than left as `Promise<unknown[]>` so a handler that returns the old
   * bare array is a COMPILE ERROR at the dispatch map instead of an orchestrator that reads
   * `undefined` for recordsRead and advances the cursor by NaN.
   */
  execute: (
    spec: unknown,
    cap?: number,
    startOffset?: number,
  ) => Promise<SourcingExecuteResult>
}

/** What a sourcing handler reports back. See SourcingHandler.execute. */
export interface SourcingExecuteResult {
  candidates: unknown[]
  /** Record position the run started from. */
  startOffset: number
  /** Provider rows consumed, before any post-filter. The cursor advances by this. */
  recordsRead: number
  /** True when the run stopped at the provider's reachable-record ceiling. */
  ceilingReached: boolean
  /**
   * True when the provider has no more rows for this query, so a further window is pointless.
   *
   * DISTINCT FROM ceilingReached. That one means the provider will not PAGE any deeper (50,000
   * records) and is a property of the provider. This one means the result set itself ran out,
   * which is a property of the query, and is the ordinary way a run ends.
   *
   * REQUIRED, not optional, so a handler cannot omit it and leave the caller to infer
   * exhaustion from a short window. That inference is wrong on the exact boundary: a result set
   * of 300 read in windows of 100 returns a full window every time, and the caller would spend
   * one more provider call on an empty page to find out there was nothing left.
   */
  resultSetExhausted: boolean
}

// Re-exported from the ONE list in icp-filter-spec.ts. See "Layer G" there.
//
// This used to be its own 19-name array and it disagreed with both ICPFilterSpec and the
// Apollo handler's SUPPORTED_FIELDS. Six of those names (`departments`,
// `company_age_min_years`, `company_age_max_years`, `technologies_used`, `funding_stage`,
// `funded_since`) have never existed on ICPFilterSpec, so the orchestrator's manifest
// check read `undefined` for them on every run and they could never be "populated".
// `company_revenue_min` and `company_revenue_max` were the same. Removing them is
// therefore not a behaviour change: it removes eight names that could not fire.
//
// The real defect was the other direction. A field added to ICPFilterSpec and not to this
// list was silently NEVER CHECKED by the manifest gate, so a handler could discard it
// with no divergence reported. Deriving from one list is what closes that.
export { FILTER_SPEC_FIELDS as FILTER_FIELDS } from '@/lib/agents/icp-filter-spec'

export {}
