// Shared types for the durable job queue.
//
// The queue covers the three units of work that are slow, cost money, and run once per
// PROSPECT: enrichment, research and composition. Document generation is deliberately
// absent: those agents run once per client, not once per prospect, and they finish
// inside a request comfortably.
//
// See ADR-029 for why this is a separate table from agent_runs.

export const JOB_TYPES = ['enrich', 'research', 'compose'] as const
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
