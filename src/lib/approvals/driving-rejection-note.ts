// Pairing a pending suggestion with the operator note that caused it to exist.
//
// THE NOTE IS NOT ON THE PENDING ROW, and that is the whole difficulty. Rejecting a
// suggestion writes rejection_reason onto the row being REPLACED and flips that row to
// 'rejected'. The regeneration then creates a DIFFERENT row. So adding rejection_reason to
// the approvals query returns NULL for every pending row: it looks like a fix, compiles,
// and displays nothing.
//
// The note therefore has to be looked up on the predecessor, and the pairing has to be
// honest about what it can prove. There is no foreign key from a suggestion to the one it
// replaced, so "caused" is not available. What is available is "most recently rejected for
// the same organisation and document type, BEFORE this one was created", which is the
// predecessor in every path that exists today: only one suggestion per document type can be
// pending at a time, so a rejection is always followed by at most one new row.
//
// The ordering condition is what stops it lying. Without it, a rejection with no
// regeneration behind it would attach itself to whatever suggestion appeared next, however
// much later and for whatever unrelated reason.

export interface PendingRow {
  id: string
  organisation_id: string
  document_type: string
  created_at: string | null
}

export interface RejectedRow {
  organisation_id: string
  document_type: string
  rejection_reason: string | null
  reviewed_at: string | null
}

export interface DrivingRejectionNote {
  note: string
  rejected_at: string
}

/**
 * Returns a map from pending suggestion id to the rejection note that preceded it.
 * A pending row with no qualifying predecessor is absent from the map.
 */
export function findDrivingRejectionNotes(
  pending: PendingRow[],
  rejected: RejectedRow[],
): Map<string, DrivingRejectionNote> {
  const result = new Map<string, DrivingRejectionNote>()

  for (const row of pending) {
    if (!row.created_at) continue

    let best: DrivingRejectionNote | null = null
    for (const candidate of rejected) {
      if (candidate.organisation_id !== row.organisation_id) continue
      if (candidate.document_type !== row.document_type) continue

      const note = candidate.rejection_reason?.trim()
      if (!note) continue
      if (!candidate.reviewed_at) continue

      // Only a rejection that happened BEFORE this suggestion was created can have
      // produced it. Dropping this comparison is what makes the feature lie.
      if (candidate.reviewed_at > row.created_at) continue

      if (!best || candidate.reviewed_at > best.rejected_at) {
        best = { note, rejected_at: candidate.reviewed_at }
      }
    }

    if (best) result.set(row.id, best)
  }

  return result
}
