// Does this person hold another current position, somewhere else?
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS IS CODE AND NOT A MODEL CALL
//
// Enrichment already buys the answer. people/bulk_match returns employment_history, and the
// stored subset keeps `current`, `end_date`, `organization_id` and the person's own
// `organization_id` alongside it. Counting entries is arithmetic.
//
// It was being decided by the research synthesis call instead, as the primary_occupation
// check, which happens AFTER $0.13 to $0.19 of model spend per prospect. Worse, the prompt is
// shown only the three most recent entries, while the stored array averages 7.6: the model
// decides it from less than the database holds.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT IT DELIBERATELY DOES NOT ANSWER
//
// Whether the other position is FULL TIME. The provider returns no such flag: the kept fields
// carry dates, an employer and a free-text description, and nothing that distinguishes a
// standing commitment from an occasional one. Judging that from a title would mean writing
// title vocabulary into this repository, which Rule Zero forbids and which would be one
// market's vocabulary applied to every client.
//
// So this counts, and the model still judges. Two numbers come back:
//
//   identified  a current position whose employer id is PRESENT and differs from their own.
//               The provider is telling us plainly that they hold another job.
//   ambiguous   a current position with no employer id at all. The provider cannot tell us
//               whose it is, so neither can this. Measured on one client's 100 enriched
//               prospects: 33 identified, 20 ambiguous.
//
// Only `identified` gates. An ambiguous entry is exactly the case that needs a reading rather
// than a count, and it is left to the judge.

/** One current position elsewhere is enough: the question is whether another job exists at all. */
export const CONCURRENT_ROLES_THAT_REMOVE = 1

export interface ConcurrentRoleCount {
  /** Current positions at another employer, where the provider named that employer. */
  identified: number
  /** Current positions the provider did not attach an employer to. Never gates. */
  ambiguous: number
}

interface EmploymentEntry {
  current?: unknown
  end_date?: unknown
  organization_id?: unknown
}

/**
 * Count the person's current positions at OTHER organisations, from the stored enrichment blob.
 *
 * Pure. Takes the blob as unknown and reads defensively: every row in the database predates
 * this function, and a row whose shape is not what is expected must count as nothing rather
 * than throw inside a batch.
 *
 * A position counts as current when the provider says `current: true`, or when it left
 * `current` unset and recorded no end date. The second arm matters because `current` is absent
 * on some stored rows, and an open-ended position is the provider's other way of saying it.
 */
export function countConcurrentCurrentRoles(enrichment: unknown): ConcurrentRoleCount {
  const empty: ConcurrentRoleCount = { identified: 0, ambiguous: 0 }
  if (!enrichment || typeof enrichment !== 'object') return empty

  const blob = enrichment as { organization_id?: unknown; employment_history?: unknown }
  const history = Array.isArray(blob.employment_history) ? blob.employment_history : null
  if (!history) return empty

  const ownOrgId = typeof blob.organization_id === 'string' ? blob.organization_id : null

  let identified = 0
  let ambiguous = 0
  for (const raw of history) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as EmploymentEntry
    const isCurrent = entry.current === true || (entry.current === undefined && entry.end_date === null)
    if (!isCurrent) continue

    const orgId = typeof entry.organization_id === 'string' && entry.organization_id.trim() !== ''
      ? entry.organization_id
      : null
    if (orgId === null) { ambiguous++; continue }
    // Their own employer is not another job. With no own id on file, nothing can be told apart,
    // so every named employer is ambiguous rather than identified.
    if (ownOrgId === null) { ambiguous++; continue }
    if (orgId !== ownOrgId) identified++
  }
  return { identified, ambiguous }
}

/**
 * True when the provider plainly records another current job.
 *
 * The gate. Ambiguous entries are not counted, so this is false for a person whose only
 * evidence of a second position is an entry the provider could not attribute.
 */
export function holdsAnotherCurrentRole(enrichment: unknown): boolean {
  return countConcurrentCurrentRoles(enrichment).identified >= CONCURRENT_ROLES_THAT_REMOVE
}
