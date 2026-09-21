// Collapsing one batch of sourced candidates onto one row per person, before anything is
// written.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS: DEDUPE READS THE PAST, AND A BATCH IS NOT YET IN THE PAST
//
// getDedupeVerdict answers "does this person already exist in the database". Every
// candidate in a batch is asked that question BEFORE any of them are written, so two
// copies of a person nobody has yet are both told, correctly, that they are new. The
// write loop then inserts the first and the unique index on
// (organisation_id, source_person_key) rejects the second, and the whole run throws
// part-written.
//
// Measured, organisation 0ed34697 on 2026-09-21: a run asking for 200 spanned two
// provider pages of 100. Provider page ordering is not stable between calls, so
// apollo:676ef86aa5bcbe000107a6a7 was returned on both. It was written as the 34th row at
// 15:38:58.852 and presented again as the 35th candidate. The run died there, having spent
// the provider call for all 200 records and kept 34 of them.
//
// The fix belongs HERE and not in the write loop. Skipping the second insert would still
// pay six dedupe queries for a candidate already known to be redundant, and would leave the
// batch's own duplicates invisible in the run record.
//
// ── THE SAME IDENTITY KEYS, DELIBERATELY ─────────────────────────────────────
//
// Two candidates are the same person when they share ANY of the three identities
// getDedupeVerdict matches on: source_person_key, normalised LinkedIn URL, or lowercased
// email. Using a narrower set here would let a pair through that the database-level check
// would have caught, which is the same failure one step later.
//
// FIRST ONE WINS, in arrival order, matching getDedupeVerdict's first-match-wins ordering.
// The candidates are otherwise identical by construction, so which copy survives does not
// matter; that it is deterministic does.
//
// This is deterministic code with no model call, per ADR-018: it is set membership, not
// judgment.

import { normaliseLinkedInUrl } from './normalise-linkedin'

/** Which of the three identities collided. Carried so the log line says why. */
export type InBatchDuplicateReason =
  | 'duplicate_in_batch_person_key'
  | 'duplicate_in_batch_linkedin'
  | 'duplicate_in_batch_email'

/** The identity fields this collapse reads. A superset of what any one handler supplies. */
export interface InBatchCandidate {
  source_person_key: string
  email?: string | null
  linkedin_url?: string | null
}

export interface InBatchDedupeResult<T extends InBatchCandidate> {
  /** One candidate per distinct person, in arrival order. Safe to write. */
  unique: T[]
  /** The copies dropped, each with the identity that collided. */
  duplicates: Array<{ candidate: T; reason: InBatchDuplicateReason }>
}

/**
 * Collapse a batch onto one candidate per person.
 *
 * Pure: reads nothing and writes nothing. The caller decides what to do with the drops.
 */
export function removeInBatchDuplicates<T extends InBatchCandidate>(
  candidates: T[],
): InBatchDedupeResult<T> {
  const seenPersonKeys = new Set<string>()
  const seenLinkedIn = new Set<string>()
  const seenEmails = new Set<string>()

  const unique: T[] = []
  const duplicates: Array<{ candidate: T; reason: InBatchDuplicateReason }> = []

  for (const candidate of candidates) {
    // An empty key is not an identity. Registering one would make every later candidate
    // missing that field a duplicate of the first, which silently drops real people.
    const personKey = candidate.source_person_key || null
    const linkedIn = candidate.linkedin_url ? normaliseLinkedInUrl(candidate.linkedin_url) : null
    const email = candidate.email ? candidate.email.toLowerCase() : null

    let reason: InBatchDuplicateReason | null = null
    if (personKey && seenPersonKeys.has(personKey)) {
      reason = 'duplicate_in_batch_person_key'
    } else if (linkedIn && seenLinkedIn.has(linkedIn)) {
      reason = 'duplicate_in_batch_linkedin'
    } else if (email && seenEmails.has(email)) {
      reason = 'duplicate_in_batch_email'
    }

    if (reason) {
      duplicates.push({ candidate, reason })
      continue
    }

    // Every identity this candidate carries is registered, not just the one checked first.
    // A pair sharing only a LinkedIn URL must collide on it even though their person keys
    // differ.
    if (personKey) seenPersonKeys.add(personKey)
    if (linkedIn) seenLinkedIn.add(linkedIn)
    if (email) seenEmails.add(email)

    unique.push(candidate)
  }

  return { unique, duplicates }
}
