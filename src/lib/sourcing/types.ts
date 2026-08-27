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

export type SourcingTriggerType = 'inventory_monitor' | 'operator_manual'

export interface SourcingRunResult {
  organisation_id: string
  trigger_type: SourcingTriggerType
  candidates_sourced: number
  candidates_qualified: number
  run_timestamp: string
  error?: string
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

  adapter: (spec: unknown) => unknown
  execute: (spec: unknown, cap?: number) => Promise<unknown[]>
}

export const FILTER_FIELDS = [
  'job_titles',
  'job_titles_excluded',
  'seniority_levels',
  'departments',
  'person_countries',
  'company_countries',
  'company_headcount_min',
  'company_headcount_max',
  'industries',
  'industries_excluded',
  'keywords',
  'keywords_excluded',
  'company_revenue_min',
  'company_revenue_max',
  'company_age_min_years',
  'company_age_max_years',
  'technologies_used',
  'funding_stage',
  'funded_since',
]

export {}
