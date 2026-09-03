// Which strategy documents are built from which.
//
// ONE list, imported by everything that needs it, because it is expressed in two places
// that must agree and neither can see the other:
//
//   1. promote_strategy_doc_version, in SQL, which marks downstream documents stale when
//      an upstream one changes.
//   2. triggerCascadeIfEligible, in TypeScript, which dispatches the agent for a
//      downstream document that does not exist yet.
//
// A second hand-maintained copy of a dependency graph is the parallel-array shape from
// CLAUDE.md wearing different clothes: adding a document type to one and not the other
// produces no error, and the symptom is a document that silently never goes stale.
// __tests__/document-dependencies.test.ts reads the migration and asserts the SQL agrees
// with this file. That test scans a migration, so it proves what the migration said and
// not what the database currently does; it is an early warning, not the authority.

export type StrategyDocType = 'icp' | 'positioning' | 'tov' | 'messaging'

export const STRATEGY_DOC_TYPES: readonly StrategyDocType[] = [
  'icp',
  'positioning',
  'tov',
  'messaging',
] as const

/**
 * Documents that are built FROM the key, and are therefore potentially out of date once
 * the key changes.
 *
 * Messaging is downstream of all three. Positioning is downstream of the prospect
 * profile. The voice guide is downstream of nothing: it is derived from how the client
 * writes, not from who they target.
 */
export const DOWNSTREAM_OF: Record<StrategyDocType, readonly StrategyDocType[]> = {
  icp: ['positioning', 'messaging'],
  positioning: ['messaging'],
  tov: ['messaging'],
  messaging: [],
}

function upstreamOf(downstream: StrategyDocType): readonly StrategyDocType[] {
  return STRATEGY_DOC_TYPES.filter(upstream => DOWNSTREAM_OF[upstream].includes(downstream))
}

/**
 * Documents the key is built FROM. The inverse of DOWNSTREAM_OF.
 *
 * WRITTEN AS AN OBJECT LITERAL ON PURPOSE, not built with Object.fromEntries. The first
 * version used fromEntries plus `as Record<StrategyDocType, ...>`, and that cast is
 * exactly the shape CLAUDE.md warns about: it switches off the completeness check that
 * makes this safe. As a literal, adding a fifth document type to StrategyDocType is a
 * COMPILE ERROR here until it is given an entry, which is the notification you want.
 * The VALUES are still derived from DOWNSTREAM_OF, so the two cannot disagree.
 */
export const UPSTREAM_OF: Record<StrategyDocType, readonly StrategyDocType[]> = {
  icp: upstreamOf('icp'),
  positioning: upstreamOf('positioning'),
  tov: upstreamOf('tov'),
  messaging: upstreamOf('messaging'),
}

/** Segment-scoped documents. The other two are org-level and always carry segment_id NULL. */
export const SEGMENT_SCOPED: readonly StrategyDocType[] = ['icp', 'messaging'] as const

export function isStrategyDocType(value: string): value is StrategyDocType {
  return (STRATEGY_DOC_TYPES as readonly string[]).includes(value)
}
