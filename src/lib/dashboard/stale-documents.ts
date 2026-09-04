// Which live documents are marked stale, and what to tell the operator about each.
//
// DETERMINISTIC. A pure function over rows already fetched, per ADR-018.
//
// ─────────────────────────────────────────────────────────────────────────────
// A STALE DOCUMENT IS A FLAG, NOT A VERDICT
//
// promote_strategy_doc_version sets is_stale on the documents built from a document that
// just changed. It cannot know whether the change is relevant: a rewritten prospect
// profile may or may not mean the messaging is now wrong. So the copy here says what
// happened and never says the document is broken. The operator reads both and decides.
//
// WHAT IT DOES NOT SAY, AND WHY. It does not name WHICH upstream document changed. The
// flag is a boolean on the downstream row and carries no provenance, so naming the cause
// would mean guessing at it from the upstream documents' timestamps. A guess presented as
// a fact is worse than the honest, shorter sentence. Recorded in BACKLOG.
//
// RULE ZERO: nothing here names an industry, sector, country, company or job title.

import {
  UPSTREAM_OF,
  isStrategyDocType,
  type StrategyDocType,
} from '@/lib/agents/cascade/document-dependencies'
import { isIntakeStaleReason } from '@/lib/intake/document-staleness'

// Client-facing labels. Never "ICP" or "TOV". Same values as strategy-nav-state, and
// deliberately not imported from it: that module is about the sidebar, and one of them
// changing its labels for its own reasons must not silently change the other.
const DOC_LABELS: Record<StrategyDocType, string> = {
  icp: 'Prospect profile',
  positioning: 'Positioning',
  tov: 'Voice guide',
  messaging: 'Messaging',
}

export interface StaleDocRow {
  document_type: string
  status: string | null
  is_stale: boolean | null
  /**
   * Why the flag was set, or null for the document-to-document path. Optional so a caller
   * that has not added it to its select still type-checks; a missing column reads as null
   * and yields exactly the previous wording.
   */
  stale_reason?: string | null
}

export interface StaleDocument {
  docType: StrategyDocType
  label: string
  /** One sentence naming what happened. Never a verdict about the document. */
  reason: string
}

/**
 * @param documents strategy_documents rows for one organisation. ARCHIVED ROWS ARE
 *                  FILTERED OUT HERE rather than at the query, because an archived row
 *                  can carry is_stale = true for ever: it was flagged and then replaced,
 *                  and the flag was never cleared because clearing it would rewrite
 *                  history. Only the live document can be stale.
 */
export function selectStaleDocuments(documents: StaleDocRow[]): StaleDocument[] {
  const stale = documents.filter(
    d => d.status === 'active' && d.is_stale === true && isStrategyDocType(d.document_type),
  )

  // Fixed document order, not arrival order, so the list reads the same every time.
  const order: StrategyDocType[] = ['icp', 'positioning', 'tov', 'messaging']

  return order
    .filter(type => stale.some(d => d.document_type === type))
    .map(type => ({
      docType: type,
      label: DOC_LABELS[type],
      reason: buildReason(
        type,
        stale.find(d => d.document_type === type)?.stale_reason ?? null,
      ),
    }))
}

function buildReason(type: StrategyDocType, staleReason: string | null): string {
  // An intake answer changing is not an upstream DOCUMENT changing, and for the prospect
  // profile there is no upstream document at all. Inferring the usual sentence here would
  // name a cause that did not happen, which is the guess-presented-as-fact this file exists
  // to avoid. The field key is deliberately NOT shown: it is an internal name, and the
  // client-facing point is that an answer changed, not which column holds it.
  if (isIntakeStaleReason(staleReason)) {
    return 'Written before one of your intake answers was changed. It may still be right. ' +
      'Regenerate it if it is not.'
  }

  const upstream = UPSTREAM_OF[type]
  if (upstream.length === 0) {
    // Unreachable with today's graph, because nothing marks a document with no upstream.
    // Kept so a future graph change cannot produce an empty sentence on screen.
    return 'A document this one is built from has changed since this version was written.'
  }

  const names = upstream.map(u => DOC_LABELS[u])
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`

  return `Written before the latest ${list}. It may still be right. Regenerate it if it is not.`
}
