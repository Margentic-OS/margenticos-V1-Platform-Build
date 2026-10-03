// What a stored competitor verdict MEANS, with no dependency on anything.
//
// Split from competitor-screen.ts so tiering can read a verdict without importing the
// screen, which carries a model client. Tiering is free and deterministic and must stay
// that way: it reads what the screen decided and never decides it.

/** The removal reason an excluded prospect carries. Registered in REMOVAL_REASONS. */
export const COMPETITOR_REMOVAL_REASON = 'competitor'

/**
 * Does this stored value say the prospect was excluded as a competitor?
 *
 * Read by classifyTier FIRST, which is what makes an exclusion survive every re-tier: a
 * later tiering run, the industry-tag re-tier and the settings-change thaw all return
 * 'competitor' again instead of quietly re-admitting the company.
 *
 * Deliberately not aware of which category list the verdict was judged against. Tiering has
 * no brief in hand and must not need one. A verdict made stale by a changed list is
 * corrected by the screen, which is its only writer.
 */
export function isCompetitorExcluded(check: unknown): boolean {
  return !!check && typeof check === 'object' && (check as { outcome?: unknown }).outcome === 'excluded'
}
