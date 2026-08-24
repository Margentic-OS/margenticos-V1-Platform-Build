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
// ═════════════════════════════════════════════════════════════════════════════
// WHY ORDERING BY OLDEST IS NOT ENOUGH ON ITS OWN, AND WHY THE CURSOR EXISTS
//
// The first version of this file ordered organisations by their oldest queued job and
// stopped there. That is not a round-robin. It is a priority queue that always returns
// the same answer.
//
// Worked example, research, which is the job type whose ceiling cannot be raised:
// maxInFlight 10 rows, claimBatchSize 5, so exactly two organisations fit per pass.
// With orgs A, B and C all holding deep backlogs, A and B are served and C is not.
// On the next tick A and B are STILL the two oldest, because their remaining jobs were
// created at the same time as the ones just claimed. C is not served then either, or on
// any tick after it, for as long as A and B have work. C waits forever.
//
// So the planner needs memory. It starts each pass at the organisation AFTER the one it
// finished on last time, which turns a fixed priority order into a genuine rotation.
//
// WHERE THE CURSOR LIVES: the queue_rotation table, one row per job_type, holding
// last_organisation_id. It is deliberately NOT in system_flags (that table is booleans
// for rollout), NOT in job_queue (that is per-job state, and the cursor outlives every
// individual job), and NOT in worker memory (each Vercel invocation is a fresh process,
// so in-memory rotation would reset on every tick and rotate nothing).
//
// planClaims itself stays PURE. It is handed the cursor and returns the next one, so
// the rotation property is testable without a database.

/**
 * Where a pass should begin, and where it ended.
 *
 * nextCursor is the LAST organisation this pass planned for. Persisting it means the
 * following pass starts after it. Null when nothing was planned, which leaves the
 * stored cursor untouched rather than resetting the rotation to the top.
 */
export interface ClaimPlan {
  entries: ClaimPlanEntry[]
  nextCursor: string | null
}

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
  lastServedOrganisationId: string | null = null,
): ClaimPlanEntry[] {
  return planClaimsWithRotation(backlog, config, headroom, lastServedOrganisationId).entries
}

/**
 * The full planner, returning the next cursor alongside the entries.
 *
 * Rules, in order:
 *   1. Organisations are ordered oldest-job-first, which is the FIFO property worth
 *      keeping: an organisation that has waited longest sorts ahead of a newcomer.
 *   2. That order is then ROTATED to begin after the organisation served last, so the
 *      same two organisations cannot hold the front of the queue forever.
 *   3. Each organisation is capped at claimBatchSize on this pass, so no organisation
 *      can take more than its slice however deep its backlog.
 *   4. The total is capped by the remaining global in-flight headroom.
 *   5. An organisation whose slice would be zero is dropped rather than returned with
 *      limit 0, so callers never issue a pointless claim round trip.
 */
export function planClaimsWithRotation(
  backlog: OrganisationBacklog[],
  config: JobTypeConfig,
  headroom: number,
  lastServedOrganisationId: string | null = null,
): ClaimPlan {
  if (headroom <= 0) return { entries: [], nextCursor: null }

  // The SQL already orders by oldest, but this function is pure and callers may hand it
  // a list from anywhere. Sorting here means the property holds regardless.
  const ordered = [...backlog].sort((a, b) => a.oldest.localeCompare(b.oldest))

  const rotated = rotateAfter(ordered, lastServedOrganisationId)

  const entries: ClaimPlanEntry[] = []
  let remaining = headroom

  for (const org of rotated) {
    if (remaining <= 0) break

    // Never claim more than the organisation actually has waiting. Asking for 10 when 3
    // are queued is harmless at the database, but it makes the plan misreport how much
    // of the headroom this pass will really use.
    const slice = Math.min(config.claimBatchSize, remaining, Math.max(org.depth, 0))
    if (slice <= 0) continue

    entries.push({ organisation_id: org.organisation_id, limit: slice })
    remaining -= slice
  }

  return {
    entries,
    // Null when nothing was planned, so a pass that found no work leaves the stored
    // cursor alone. Resetting it to the top would undo the rotation every quiet tick.
    nextCursor: entries.length > 0 ? entries[entries.length - 1].organisation_id : null,
  }
}

/**
 * Rotate an ordered list so it begins just after `afterId`.
 *
 * When afterId is null, or names an organisation no longer in the list because its
 * backlog drained, the list is returned unrotated. That is the correct degradation:
 * an unknown cursor means "start from the oldest", which is where a fresh rotation
 * should begin anyway.
 */
function rotateAfter<T extends { organisation_id: string }>(
  ordered: T[],
  afterId: string | null,
): T[] {
  if (afterId === null || ordered.length === 0) return ordered

  const index = ordered.findIndex(o => o.organisation_id === afterId)
  if (index === -1) return ordered

  const start = (index + 1) % ordered.length
  return [...ordered.slice(start), ...ordered.slice(0, start)]
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
