// When research moves a prospect OFF a variant the messaging document no longer has.
//
// Composition has recorded this since 2026-09-20: resolveVariant writes
// variant_reassigned_from and variant_reassigned_at, and MON-033 reads them, because a live
// document missing a variant is a fact an operator needs to see. Research did not, and from
// 2026-10-01 it is research that meets such a prospect first: resolveVariantId now chooses
// again when the assigned variant is gone, and writes the new variant to the row. Without
// the record, composition later finds a valid variant, records nothing, and the monitor
// stays OK while prospects are quietly being moved.
//
// ITS OWN MODULE, deliberately not in produce-opening.ts: that module is replaced wholesale
// by vi.mock in the collect tests, and a new export there would be undefined at run time.
//
// Pure. The caller holds the variant the prospect had, the one research chose, and the
// messaging content the choice was made against.
//
// KNOWN LIMIT ON THE BATCH PATH. Collection compares the row's variant with the document
// SNAPSHOTTED when the batch was submitted, up to a day earlier. If a newer document was
// approved in between and composition assigned a variant only the newer one has, this
// records it as "left because the document does not have it", and MON-033 raises for a
// move that is really the snapshot winning. Rare, and it errs towards being seen.

/**
 * The variant the prospect is leaving BECAUSE THE DOCUMENT DOES NOT HAVE IT, or null.
 *
 * Null when nothing changed, when there was no previous variant, and when the previous
 * variant still exists in the document: a prospect moved between two live variants is the
 * offer-line selector doing its job, not a missing variant, and must not raise the monitor.
 */
export function reassignedFromMissingVariant(
  previousVariantId: string | null | undefined,
  chosenVariantId: string | null | undefined,
  messagingContent: unknown,
): string | null {
  if (!previousVariantId || !chosenVariantId || previousVariantId === chosenVariantId) return null
  const variants = (messagingContent as { variants?: unknown } | null | undefined)?.variants
  if (!variants || typeof variants !== 'object') return null
  if (Object.keys(variants as Record<string, unknown>).includes(previousVariantId)) return null
  return previousVariantId
}

/** The prospect columns that record the move. Empty when there is nothing to record. */
export function reassignmentColumns(
  reassignedFrom: string | null | undefined,
  now: Date,
): { variant_reassigned_from?: string; variant_reassigned_at?: string } {
  return reassignedFrom
    ? { variant_reassigned_from: reassignedFrom, variant_reassigned_at: now.toISOString() }
    : {}
}
