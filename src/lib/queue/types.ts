// Shared types for the durable job queue.
//
// The queue covers the units of work that are slow, cost money, and run once per
// PROSPECT: enrichment, research and composition. Document generation is deliberately
// absent: those agents run once per client, not once per prospect, and they finish
// inside a request comfortably.
//
// See ADR-029 for why this is a separate table from agent_runs.

// ── research vs research_sources + research_collect ──────────────────────────
//
// 'research' is the ORIGINAL single-job path: sources, synthesis, writer and judge in
// one claimed job. It is proven in production and it is NOT being removed.
//
// 'research_sources' and 'research_collect' are the same work split either side of an
// Anthropic Batch API wait, which buys 50% off the synthesis call. The split exists
// because a batch may take 24 hours and nothing here can hold a lease that long:
// research's lease is 360 seconds and reap-agent-runs kills any agent_runs row still
// 'running' after 600.
//
// The two paths are MUTUALLY EXCLUSIVE and the database enforces it, because both fetch
// sources and therefore both start Apify actors against a measured ceiling of 25
// concurrent runs. See system_flags_research_path_exclusive in
// 20260826130000_research_batch_job_types.sql.
export const JOB_TYPES = [
  'enrich',
  'research',
  'compose',
  'research_sources',
  'research_collect',
] as const
export type JobType = (typeof JOB_TYPES)[number]

export const JOB_STATES = ['queued', 'claimed', 'done', 'failed', 'cancelled'] as const
export type JobState = (typeof JOB_STATES)[number]

/**
 * How a failure should be treated.
 *
 * 'transient'  the same call might succeed later. Back off and retry until the cap.
 * 'permanent'  the same call will fail identically forever. Terminate now.
 *
 * Classified at the point of failure and stored, never re-derived from the error
 * string afterwards. Getting this wrong in one direction loses work, and in the other
 * burns money reaching an answer we already had.
 */
export type ErrorClass = 'transient' | 'permanent'

/** One row of job_queue. Mirrors the table created in 20260824160000_job_queue.sql. */
export interface JobRow {
  id: string
  job_type: JobType
  organisation_id: string
  prospect_id: string
  state: JobState
  claimed_by: string | null
  lease_expires_at: string | null
  attempts: number
  max_attempts: number
  run_after: string
  last_error: string | null
  last_error_class: ErrorClass | null
  /**
   * Non-null means an external PAID call already returned for this job.
   *
   * This is the single fact that makes a lease safe. A reclaimed job carrying this
   * stamp must never call the paid API again, because the response we paid for cannot
   * be reconstructed and calling again is the 3de0589 bug.
   */
  spend_recorded_at: string | null
  spend_detail: Record<string, unknown> | null
  result_summary: string | null
  enqueued_by: string | null
  created_at: string
  updated_at: string
}

/** One organisation with queued work, from queue_next_organisations. */
export interface OrganisationBacklog {
  organisation_id: string
  oldest: string
  depth: number
}
