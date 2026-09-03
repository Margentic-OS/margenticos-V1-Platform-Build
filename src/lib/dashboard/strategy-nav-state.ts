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
// messaging. Once all four exist they are reference material. A client reads them
// twice and then wants the space back, so the section collapses by default.
//
// It expands, and CANNOT be collapsed by default, whenever something there needs the
// client. Two cases, and the first is the serious one:
//
//   1. A DOCUMENT DOES NOT EXIST YET. That is not a tidiness question.
//      assertStrategyApproved blocks the lead upload until all four exist, so a missing
//      document is the thing standing between a client and any outreach at all.
//      Collapsing the section would hide the blocker behind a chevron.
//
//   2. A NEW VERSION IS WAITING ON THE OPERATOR. A suggestion exists that has not been
//      acted on. Nothing is blocked, but there is something in flight.
//
// Both are computed here rather than in the sidebar so that the reason survives into the
// UI and into a test, instead of being an anonymous boolean.
//
// ─── WHAT CHANGED 2026-09-03 ─────────────────────────────────────────────────
//
// Case 1 used to be "a document is not APPROVED", reading client_approval_status.
// Client approval on strategy documents is removed (ADR-039), so the case is now
// "a document does not exist". A row that exists is live, and a live document is not
// something the client has to clear.

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
}

export type StrategyNavReason = 'blocking_upload' | 'pending_version' | 'all_present'

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
 *                             type counts as blocking, because that is exactly how the
 *                             upload gate treats it.
 *
 *                             ARCHIVED ROWS MUST NOT BE IN THIS LIST. The client RLS
 *                             policy now admits them so version history can be read, so
 *                             a caller that forgets the status filter would report every
 *                             document present for ever.
 * @param pendingSuggestionTypes document_type values with a pending suggestion.
 */
export function deriveStrategyNavState(
  documents: StrategyDocRow[],
  pendingSuggestionTypes: string[],
): StrategyNavState {
  const present = new Set(documents.map(d => d.document_type))

  const missing = STRATEGY_DOC_TYPES.filter(t => !present.has(t))

  if (missing.length > 0) {
    // Blocking. Never collapsed.
    return {
      collapsedByDefault: false,
      reason: 'blocking_upload',
      needsAttention: missing.map(t => STRATEGY_DOC_LABELS[t]),
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

  return { collapsedByDefault: true, reason: 'all_present', needsAttention: [] }
}
