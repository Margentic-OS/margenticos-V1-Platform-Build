// WHICH PROSPECTS PUBLISHING WOULD ACTUALLY ACT ON. ONE DEFINITION.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS
//
// The button read "Check 190 and publish for the client" where 190 was every prospect that
// had ever reached a tier, five batches' worth, almost all of them published weeks earlier
// and already in the client's campaign.
//
// THE ACTION WAS ALREADY CORRECT. publish-all-tiers has always filtered on
// `tier_published_at IS NULL`, so pressing it published only the new ones. Nothing was
// over-published and no behaviour needed changing. The LABEL was counting a different
// population from the one the click would touch, which is the same defect as the research
// button that read 21 against an actionable 0: a label and its action that are two separate
// predicates, kept in step by hand.
//
// So the filter lives here and both apply it. The number on the button is the number of
// rows the update will match, by construction.

/**
 * Narrow a prospects query to rows that are tiered and NOT yet published.
 *
 * Takes and returns the query so the caller decides the shape: the route needs an UPDATE
 * scoped to one tier, the label needs a `head: true` count across all three.
 *
 * `suppressed = false` is part of the definition, not an extra: a suppressed prospect is
 * never published, so counting one would promise work the update will not do.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function selectUnpublished<Q extends any>(query: Q): Q {
  return (query as any) // eslint-disable-line @typescript-eslint/no-explicit-any
    .is('tier_published_at', null)
    .eq('suppressed', false) as Q
}
