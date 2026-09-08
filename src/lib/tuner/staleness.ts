// Can a plan tell that the document it was built from has moved?
//
// ─── THE FAILURE THIS PREVENTS, MEASURED RATHER THAN IMAGINED ────────────────
//
// A client's search settings are rebuilt from their ICP document on every approval, every
// revision and every revert. The document row is UPDATED IN PLACE: its id does not change,
// its version does, and the spec derived from it is overwritten.
//
// So a plan holding only the document id would resolve fine forever while describing a
// document that no longer exists in that form.
//
// MEASURED between 2026-09-07 and 2026-09-08. One live organisation's ICP went from version
// 4 to version 8, and the population its stored search reaches fell from 142 people to 1.
// Same document id throughout. A plan built on the seventh would have reported itself
// current on the eighth while being wrong about the only number that mattered.
//
// ─── WHY THREE FIELDS AND NOT TWO ────────────────────────────────────────────
//
// Version alone is nearly enough, and nearly is the problem: `version` is a text column, it
// is written by several paths, and a revert can restore an earlier version number onto a row
// whose content has moved on. `updated_at` catches that case, and catches an in-place edit
// that does not bump the version at all. Either differing means stale, so the check is a
// disjunction and not a comparison of the pair.

import type { DocumentMarker } from '@/lib/tuner/types'

export interface StalenessVerdict {
  stale: boolean
  /** Which of the three moved. Empty when current. */
  changed: ('document_id' | 'version' | 'updated_at')[]
  /** Operator-facing sentence. Empty when current. */
  reason: string
}

/** The document as it stands now, read at the moment the question is asked. */
export interface CurrentDocument {
  id: string
  version: string
  updated_at: string
}

/**
 * Compare a plan's marker against the document as it stands.
 *
 * A MISSING MARKER IS STALE, not current. A plan that cannot say what it was built from
 * cannot be shown to still describe it, and defaulting that to "fine" is how a plan
 * outlives its document silently. This is the direction the check must fail in.
 */
export function checkStaleness(
  marker: DocumentMarker | null | undefined,
  current: CurrentDocument | null | undefined,
): StalenessVerdict {
  if (!marker) {
    return {
      stale: true,
      changed: ['document_id', 'version', 'updated_at'],
      reason:
        'This plan records no document marker, so it cannot be shown to describe the ' +
        'document in force. Treated as stale.',
    }
  }

  if (!current) {
    return {
      stale: true,
      changed: ['document_id'],
      reason:
        `This plan was built from document ${marker.documentId} version ${marker.version}, ` +
        'which is no longer the active document for this organisation. Treated as stale.',
    }
  }

  const changed: StalenessVerdict['changed'] = []
  if (marker.documentId !== current.id) changed.push('document_id')
  if (marker.version !== current.version) changed.push('version')
  if (!sameInstant(marker.updatedAt, current.updated_at)) changed.push('updated_at')

  if (changed.length === 0) {
    return { stale: false, changed: [], reason: '' }
  }

  return {
    stale: true,
    changed,
    reason:
      `The document this plan was built from has moved: ${changed.join(', ')} ` +
      `${changed.length === 1 ? 'differs' : 'differ'}. The plan was built from version ` +
      `${marker.version} (updated ${marker.updatedAt}); the active document is now version ` +
      `${current.version} (updated ${current.updated_at}). A client's search settings are ` +
      'rebuilt from the document on every approval, revision and revert, so this plan may ' +
      'describe a population that no longer applies. Re-run the tuner.',
  }
}

/**
 * Timestamp equality that survives a round trip through the database and back.
 *
 * Postgres returns `timestamptz` in its own textual form and the client may hand it back
 * with a different offset or a different number of fractional digits. Comparing the strings
 * would report a plan stale every time it was reloaded, which trains an operator to ignore
 * the warning. Comparing the instants is the question actually being asked.
 *
 * An unparseable value on either side is treated as NOT equal, so a malformed timestamp
 * reports stale rather than current.
 */
function sameInstant(a: string, b: string): boolean {
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false
  return ta === tb
}
