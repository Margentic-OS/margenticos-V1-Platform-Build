// Deterministic variant assignment. ONE implementation, shared.
//
// The hash lived inline inside resolveVariant in compose-sequence.ts. The research
// writer now needs the same answer, because it writes an opening FOR a specific
// variant's Email 1 and has to target the variant composition will actually pick. Two
// copies of this arithmetic would drift silently: the writer would tune copy for variant
// B while composition shipped variant D, and nothing would fail loudly.
//
// Deterministic by design (ADR-018). Same prospect id and same variant set always yield
// the same variant, with no database read and no randomness, so research and composition
// agree without coordinating.

/**
 * Stable 32-bit string hash. Not cryptographic and not meant to be: it only has to be
 * stable across processes and evenly spread over a handful of buckets.
 */
export function stableHash(input: string): number {
  let hash = 0
  for (const char of input) {
    hash = ((hash << 5) - hash) + char.charCodeAt(0)
    hash = hash & hash // force back to a 32-bit integer
  }
  return hash
}

/**
 * Picks a variant for a prospect. `availableVariants` must be sorted by the caller so the
 * mapping is stable when a document gains or loses a variant in a different order.
 */
export function assignVariantDeterministically(
  prospectId: string,
  availableVariants: string[],
): string {
  if (availableVariants.length === 0) {
    throw new Error('assignVariantDeterministically: no variants available to assign')
  }
  return availableVariants[Math.abs(stableHash(prospectId)) % availableVariants.length]
}
