// Deciding which organisation's work to take next, and how much of it.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE PROBLEM PLAIN FIFO CREATES
//
// Order the whole queue by created_at and one client's 3,333-prospect batch takes every
// slot until it drains. A second client's 10-prospect run waits behind all of it. At
// research speeds that is days, for a batch that would finish in minutes on its own.
//
// Round-robin bounds a client's wait by the NUMBER of active organisations rather than
// by the DEPTH of the largest batch. With three active clients and a one-minute tick,
// the third waits about three minutes no matter how much work the first has queued.
//
// This function is pure so the property can be tested directly, rather than inferred
// from watching a live queue drain.

import type { JobTypeConfig } from './config'
import type { OrganisationBacklog } from './types'

export interface ClaimPlanEntry {
  organisation_id: string
  /** How many jobs to claim from this organisation on this pass. */
  limit: number
}

/**
 * Turn "who has work waiting" into "what this invocation will claim".
 *
 * Rules, in order:
 *   1. Organisations are visited oldest-job-first. An organisation that has been
 *      waiting longest goes first, which is the FIFO property worth keeping.
 *   2. Each organisation is capped at claimBatchSize on this pass. This is the whole
 *      anti-starvation mechanism: no organisation can take more than its slice, however
 *      deep its backlog.
 *   3. The total is capped by the remaining global in-flight headroom, so the pacing
 *      ceiling sized off Apify concurrency is never exceeded by fanning across orgs.
 *   4. An organisation whose slice would be zero is dropped rather than returned with
 *      limit 0, so callers never issue a pointless claim round trip.
 *
 * `headroom` is (maxInFlight - currently claimed). Zero or negative means claim nothing:
 * the pacing ceiling is already met and the correct action is to wait, not to queue more
 * concurrent external calls.
 */
export function planClaims(
  backlog: OrganisationBacklog[],
  config: JobTypeConfig,
  headroom: number,
): ClaimPlanEntry[] {
  if (headroom <= 0) return []

  // Defensive: the SQL already orders by oldest, but this function is pure and callers
  // may hand it a list from anywhere. Sorting here means the property holds regardless.
  const ordered = [...backlog].sort((a, b) => a.oldest.localeCompare(b.oldest))

  const plan: ClaimPlanEntry[] = []
  let remaining = headroom

  for (const org of ordered) {
    if (remaining <= 0) break

    // Never claim more than the organisation actually has waiting. Asking for 25 when 3
    // are queued is harmless at the database, but it makes the plan misreport how much
    // of the headroom this pass will really use.
    const slice = Math.min(config.claimBatchSize, remaining, Math.max(org.depth, 0))
    if (slice <= 0) continue

    plan.push({ organisation_id: org.organisation_id, limit: slice })
    remaining -= slice
  }

  return plan
}

/**
 * How much room is left under the global in-flight ceiling.
 *
 * Clamped at zero: a negative headroom would otherwise flow into planClaims as a
 * negative cap and, through Math.min, silently produce a NEGATIVE claim limit. In-flight
 * can legitimately exceed the ceiling for a moment when the ceiling is lowered in config
 * while jobs are already running, so this case is real rather than theoretical.
 */
export function inFlightHeadroom(config: JobTypeConfig, currentlyClaimed: number): number {
  return Math.max(0, config.maxInFlight - currentlyClaimed)
}
