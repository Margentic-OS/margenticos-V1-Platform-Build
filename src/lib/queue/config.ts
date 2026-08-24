// Per-job-type queue sizing.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THESE NUMBERS AND NOT OTHERS
//
// Every value here is derived from a MEASURED limit, not from a guess. Where a
// measurement is stale, the comment says how to re-take it.
//
// THE BINDING CONSTRAINT IS APIFY, NOT ANTHROPIC. This is worth stating loudly
// because the natural assumption is the opposite.
//
// Measured live 2026-08-24 from Anthropic response headers, identical across
// claude-haiku-4-5-20251001, claude-opus-4-6 and claude-sonnet-4-6:
//
//     anthropic-ratelimit-requests-limit       10000   per minute
//     anthropic-ratelimit-input-tokens-limit   10000000 per minute
//     anthropic-ratelimit-output-tokens-limit  2000000  per minute
//
// That is about 166 requests per second. Research makes roughly three Anthropic calls
// per prospect and composition makes one. Anthropic cannot be the bottleneck at any
// volume this platform will reach, so there is no request-rate governor here.
//
// Measured live 2026-08-24 from GET https://api.apify.com/v2/users/me/limits:
//
//     maxConcurrentActorJobs            25
//     maxMonthlyUsageUsd                10      (FREE plan, $5 included credit)
//     maxMonthlyActorComputeUnits       625
//
// The LinkedIn source runs TWO actors per prospect, so concurrent research prospects
// must stay at or under 12 to respect the 25-run ceiling. That is the real dial, and
// it is a CONCURRENCY cap rather than a request rate, because what Apify limits is
// simultaneous runs and monthly dollars. A token bucket would govern neither.
//
// Apollo is limited to 600 calls/hour and bills one credit per contact. bulk_match
// takes ten people per call, which is why ENRICH claims ten at a time.

import type { JobType } from './types'

export interface JobTypeConfig {
  /**
   * How long a claim is held before it can be reclaimed.
   *
   * Sized as (worst observed job duration + margin). Too short and a live worker's job
   * is stolen while it is still running, which double-spends. Too long and a dead
   * worker's job sits unavailable for that whole period. Erring long is the safe
   * direction: a stranded job is a delay, a stolen job is a duplicate charge.
   */
  leaseSeconds: number

  /**
   * Worst-case seconds for ONE job of this type, used by the worker's deadline budget
   * to decide whether another job can still be started before the 300s wall.
   */
  worstCaseSeconds: number

  /**
   * How many jobs one claim call takes from a single organisation.
   *
   * For ENRICH this is a batch size, not a concurrency setting: Apollo's bulk_match
   * takes ten people per HTTP call. For the other two it is the per-organisation slice
   * that keeps one client's large batch from starving another's small one.
   */
  claimBatchSize: number

  /**
   * Global ceiling on jobs of this type in the 'claimed' state at once, across every
   * worker invocation and every organisation. This is the pacing mechanism.
   */
  maxInFlight: number

  /** Retry cap written onto each new job row. */
  maxAttempts: number
}

export const QUEUE_CONFIG: Record<JobType, JobTypeConfig> = {
  // Apollo bulk_match returns in seconds, so the lease is short and the batch is the
  // API's own page size. maxInFlight of 3 means at most 30 contacts in flight, well
  // inside the 600/hour ceiling even if every invocation overlapped.
  enrich: {
    leaseSeconds: 120,
    worstCaseSeconds: 60,
    claimBatchSize: 10,
    maxInFlight: 3,
    maxAttempts: 3,
  },

  // The expensive one. 46.8s per prospect of WALL CLOCK at concurrency 5
  // (FRESH_SECONDS_PER_PROSPECT in src/lib/operator/research-batch-entry.ts) means one
  // prospect occupies roughly 156 to 234 seconds of its own time. The lease covers the
  // worst case plus the full 300s invocation, because a worker killed at the wall must
  // not have its jobs stolen by the next tick while its own HTTP calls are still open.
  //
  // maxInFlight 10 is the Apify ceiling, not a preference: 10 prospects x 2 actors =
  // 20 concurrent actor runs, under the measured limit of 25. Raising this without
  // raising the Apify plan will produce actor-run rejections, not more throughput.
  //
  // maxAttempts is 2 rather than 3. A research job is the most expensive thing in the
  // system, and a third attempt at a job that has already failed twice is more likely
  // to spend money than to succeed.
  research: {
    leaseSeconds: 360,
    worstCaseSeconds: 240,
    claimBatchSize: 5,
    maxInFlight: 10,
    maxAttempts: 2,
  },

  // One Haiku call per prospect, and only when a dateable signal exists. Cheap and
  // fast, so the batch is large and the in-flight ceiling is generous. Nothing here
  // touches a per-run external quota.
  compose: {
    leaseSeconds: 120,
    worstCaseSeconds: 45,
    claimBatchSize: 25,
    maxInFlight: 20,
    maxAttempts: 3,
  },
}

/**
 * Total seconds a worker invocation will spend before it stops claiming new work.
 *
 * The platform kills the function at 300s (Hobby maximum, not a configurable default).
 * 60s is held back for cold start, the auth round trips and a slow tail, matching the
 * budget the inline research entry point already uses.
 */
export const WORKER_BUDGET_SECONDS = 240

/** How many expired leases one worker invocation will reclaim before doing other work. */
export const RECLAIM_BATCH_SIZE = 100
