// WHICH PROSPECTS ARE STILL WAITING ON EMAIL VERIFICATION. ONE DEFINITION.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS IS ITS OWN MODULE
//
// The predicate below was written inline inside verifyEnrichedBatch and nowhere else, so
// it governed BEHAVIOUR and could not be READ. The operator screen therefore showed
// nothing at all about verification: not that it was running, not how many were waiting,
// not when it last finished. A prospect simply stopped appearing downstream, which reads
// as "still working" rather than "waiting its turn".
//
// The obvious way to put a number on the screen is to write the condition a second time in
// the metrics module. That is the shape CLAUDE.md calls parallel arrays, and this codebase
// has already paid for it twice: `removed_count` and `removed_by_reason` are two
// computations of one number, and moving the buyer check in front of enrichment needed the
// same conjunct dropped in both, and it was dropped in one.
//
// So the filter moved here UNCHANGED and both callers apply it. A count on the screen and
// the rows the sweep locks cannot disagree, because there is one filter.
//
// ═════════════════════════════════════════════════════════════════════════════
// THIS FILE CHANGES NO SELECTION. It is an extraction, not a policy change.
//
// The three conditions, the two `.or()` groups, their argument order and the tier gate are
// byte-for-byte what verifyEnrichedBatch applied before this file existed. The thresholds
// are still computed from the same two constants, which stay in verification-trigger.ts and
// are passed in, so there is no second copy of a duration either.

import type { SupabaseClient } from '@supabase/supabase-js'
import { excludeTierRejected } from '@/lib/sourcing/tier-verdict'

/**
 * The two moments the filter compares against.
 *
 * PASSED IN, NEVER COMPUTED HERE. The durations belong to the sweep that owns the retry
 * policy. A second definition of "6 hours" in this file would be the very drift the module
 * exists to prevent, one level down.
 */
export interface VerificationThresholds {
  /** Grey-listed verdicts older than this are retried. */
  staleThresholdISO: string
  /** A lock older than this belonged to a run that died and is reclaimable. */
  staleLockThresholdISO: string
  /** Attempts after which the sweep stops retrying on its own. */
  maxRetryAttempts: number
}

/**
 * Narrow a prospects query to the rows the verification sweep would work on next.
 *
 * Takes and returns the query rather than building it, so the CALLER decides what to
 * select: the sweep needs columns to verify with, a count needs `head: true` and no rows at
 * all. A function that built its own query would force one shape on both and would put the
 * row ceiling in the wrong place.
 *
 * `excludeTierRejected`, not `requireTierPresent`, deliberately and unchanged: a prospect
 * tiering has not reached yet is still worth verifying, and only a REJECTION stops it. See
 * tier-verdict.ts, and ADR-060 for why research takes the opposite view of the same choice.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function selectPendingVerification<Q extends any>(
  query: Q,
  thresholds: VerificationThresholds,
): Q {
  const { staleThresholdISO, staleLockThresholdISO, maxRetryAttempts } = thresholds

  // Chained filters are ANDed by PostgREST, so this reads:
  //   enriched
  //   AND (never verified OR grey-listed and retryable)
  //   AND attempts under the cap
  //   AND (unlocked OR lock gone stale)
  //   AND not rejected by tiering
  return excludeTierRejected(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (query as any)
      .eq('enrichment_status', 'enriched')
      .or(
        `independent_email_status.is.null,and(independent_email_status.eq.Grey-listed,independent_verified_at.lt.${staleThresholdISO})`,
      )
      .lt('verification_attempt_count', maxRetryAttempts)
      .or(`verification_locked_at.is.null,verification_locked_at.lt.${staleLockThresholdISO}`),
  ) as Q
}

/**
 * How many prospects are waiting on verification for one organisation, right now.
 *
 * A `head: true` count: no rows cross the wire, so the sweep's batch ceiling is irrelevant
 * and the arithmetic is Postgres's. See the header of sourcing-metrics.ts for why every
 * count on that screen is counted this way.
 *
 * THROWS ON ERROR rather than returning 0. "0 waiting" is how an operator reads "the work
 * is done", and it must never be how they read "we could not look".
 */
export async function countPendingVerification(
  supabase: SupabaseClient,
  organisationId: string,
  thresholds: VerificationThresholds,
): Promise<number> {
  const { count, error } = await selectPendingVerification(
    supabase
      .from('prospects')
      .select('id', { count: 'exact', head: true })
      .eq('organisation_id', organisationId),
    thresholds,
  )

  if (error) {
    throw new Error(
      `Could not count prospects awaiting verification for ${organisationId}: ${error.message}`,
    )
  }
  return count ?? 0
}
