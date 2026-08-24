// src/lib/dashboard/strategy-nav-state.ts
//
// Decides whether the Strategy section of the sidebar starts collapsed.
//
// DETERMINISTIC. A pure function over rows already fetched, per ADR-018.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RULE, AND THE ONE THING IT MUST NEVER DO
//
// Four documents sit under Strategy: prospect profile, positioning, voice guide,
// messaging. Once all four are approved they are reference material. A client reads them
// twice and then wants the space back, so the section collapses by default.
//
// It expands, and CANNOT be collapsed by default, whenever something there needs the
// client. Two cases, and the first is the serious one:
//
//   1. A DOCUMENT IS NOT APPROVED. That is not a tidiness question. assertStrategyApproved
//      blocks the lead upload until all four carry client_approval_status 'approved', so
//      an unapproved document is the thing standing between a client and any outreach at
//      all. Collapsing the section would hide the blocker behind a chevron, and the client
//      would be waiting on us while we waited on them.
//
//   2. A NEW VERSION IS PENDING APPROVAL. A suggestion exists that the client has not
//      acted on. Nothing is blocked, but there is something to do.
//
// Both are computed here rather than in the sidebar so that the reason survives into the
// UI and into a test, instead of being an anonymous boolean.

export const STRATEGY_DOC_TYPES = ['icp', 'positioning', 'tov', 'messaging'] as const
export type StrategyDocType = typeof STRATEGY_DOC_TYPES[number]

// Client-facing labels. The nav does not say "ICP" or "TOV" to a client.
export const STRATEGY_DOC_LABELS: Record<StrategyDocType, string> = {
  icp: 'Prospect profile',
  positioning: 'Positioning',
  tov: 'Voice guide',
  messaging: 'Messaging',
}

export interface StrategyDocRow {
  document_type: string
  client_approval_status: string | null
}

export type StrategyNavReason = 'blocking_upload' | 'pending_version' | 'all_approved'

export interface StrategyNavState {
  collapsedByDefault: boolean
  reason: StrategyNavReason
  // Client-facing labels of the documents needing attention, in the fixed document order
  // rather than in whatever order the rows arrived.
  needsAttention: string[]
}

/**
 * @param documents            strategy_documents rows for this org, already filtered to
 *                             status in ('active', 'approved') the same way
 *                             assertStrategyApproved filters them. A missing document
 *                             type counts as unapproved, because that is exactly how the
 *                             upload gate treats it.
 * @param pendingSuggestionTypes document_type values with a pending suggestion.
 */
export function deriveStrategyNavState(
  documents: StrategyDocRow[],
  pendingSuggestionTypes: string[],
): StrategyNavState {
  const approved = new Set(
    documents
      .filter(d => d.client_approval_status === 'approved')
      .map(d => d.document_type),
  )

  const unapproved = STRATEGY_DOC_TYPES.filter(t => !approved.has(t))

  if (unapproved.length > 0) {
    // Blocking. Never collapsed.
    return {
      collapsedByDefault: false,
      reason: 'blocking_upload',
      needsAttention: unapproved.map(t => STRATEGY_DOC_LABELS[t]),
    }
  }

  const pending = new Set(pendingSuggestionTypes)
  const withPending = STRATEGY_DOC_TYPES.filter(t => pending.has(t))

  if (withPending.length > 0) {
    return {
      collapsedByDefault: false,
      reason: 'pending_version',
      needsAttention: withPending.map(t => STRATEGY_DOC_LABELS[t]),
    }
  }

  return { collapsedByDefault: true, reason: 'all_approved', needsAttention: [] }
}
