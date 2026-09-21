// How many variants a pending messaging suggestion carries, and which ones it would drop.
//
// WHY THIS EXISTS. A messaging run ships 3 of 4 variants when one slot cannot be repaired
// inside the call budget, and that was invisible at every surface. The approval screen
// showed the suggestion, the approve route checked only that a `variants` key existed, and
// composition then reassigned live prospects off the missing variant. An operator approving
// a short document could not tell it was short.
//
// PURE, and separate from the page, so both directions are testable without a database:
// a complete document reports nothing, a short one names exactly what it drops.
//
// MESSAGING ONLY. Other document types have no variants and return null rather than zero,
// because "this document has no variants" and "this document is not the kind that has
// variants" must not render the same way.

export interface VariantCoverage {
  /** Variant keys in the pending suggestion, sorted. */
  suggested: string[]
  /** Variant keys in the live document, sorted. Empty when there is no live document. */
  live: string[]
  /** In the live document and NOT in the suggestion. The prospects that would move. */
  missing: string[]
}

/** Variant keys from a stored `variants` object, sorted. Null when the shape is not one. */
function variantKeys(content: unknown): string[] | null {
  if (!content || typeof content !== 'object') return null
  const variants = (content as { variants?: unknown }).variants
  if (!variants || typeof variants !== 'object' || Array.isArray(variants)) return null
  return Object.keys(variants as Record<string, unknown>).sort()
}

/** Parses a suggestion's `suggested_value`, which is stored as a JSON string. */
export function variantKeysFromSuggestedValue(suggestedValue: string | null): string[] | null {
  if (!suggestedValue) return null
  try {
    return variantKeys(JSON.parse(suggestedValue))
  } catch {
    // A suggestion whose payload will not parse is a different problem, reported
    // elsewhere. Returning null keeps this from claiming a variant count it cannot read.
    return null
  }
}

/**
 * Compares a pending messaging suggestion against the live document it would replace.
 *
 * Returns null when there is nothing to compare: not a messaging document, or a payload
 * whose shape this cannot read. A null is "no answer", never "no problem".
 */
export function compareVariantCoverage(params: {
  documentType: string
  suggestedValue: string | null
  liveContent: unknown
}): VariantCoverage | null {
  if (params.documentType !== 'messaging') return null

  const suggested = variantKeysFromSuggestedValue(params.suggestedValue)
  if (!suggested) return null

  const live = variantKeys(params.liveContent) ?? []

  return {
    suggested,
    live,
    missing: live.filter(key => !suggested.includes(key)),
  }
}
