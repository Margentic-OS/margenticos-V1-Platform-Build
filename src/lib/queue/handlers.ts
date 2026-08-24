// Which handler runs each job type.
//
// ═════════════════════════════════════════════════════════════════════════════
// THIS REGISTRY IS DELIBERATELY EMPTY IN C3.
//
// The worker, its schedule and its monitoring are built and deployed before any job
// type is migrated, because the sequence that keeps this safe is: infrastructure first,
// then one job type at a time, each proven end to end before the next.
//
// An empty registry is therefore the CORRECT state right now, not an oversight. The
// worker runs on schedule, reclaims expired leases, reports its heartbeat, and finds
// nothing to do. That is exactly what it should do while every rollout flag is false.
//
// C4 registers 'enrich'. C5 registers 'research'. C6 registers 'compose'.
//
// ── THE FLAG AND THE HANDLER ARE TWO SEPARATE GATES, ON PURPOSE ──
//
// A job type runs only when BOTH its system_flags row is true AND a handler is
// registered here. They fail in opposite directions and the worker treats them
// differently:
//
//   flag false, no handler   normal, nothing to report beyond "disabled"
//   flag false, handler      normal. The handler is deployed and waiting to be enabled
//   flag TRUE, no handler    A CONFIGURATION ERROR, reported as a run failure. Someone
//                            enabled a job type the deployed code cannot execute, so
//                            work would pile up in the queue with nothing to run it and
//                            no other symptom. The worker refuses to claim and says so.
//
// That third case is why this file exports a lookup rather than the worker importing
// handlers directly: it makes "enabled but unrunnable" a state the worker can detect.

import type { JobHandler } from './execute-job'
import type { JobRow, JobType } from './types'

/**
 * Builds the handler for one claimed job.
 *
 * A factory rather than a bare handler because enrichment needs the whole claimed batch
 * to issue a single Apollo bulk_match call, so it has to see the other rows it was
 * claimed alongside. research and compose ignore the batch and act on ctx.job alone.
 */
export type JobHandlerFactory = (job: JobRow, claimedBatch: JobRow[]) => JobHandler

const HANDLERS: Partial<Record<JobType, JobHandlerFactory>> = {
  // enrich:   registered in C4
  // research: registered in C5
  // compose:  registered in C6
}

/** The handler factory for a job type, or null when none is deployed yet. */
export function getHandlerFactory(jobType: JobType): JobHandlerFactory | null {
  return HANDLERS[jobType] ?? null
}

/** Which job types this deployment can actually execute. */
export function registeredJobTypes(): JobType[] {
  return Object.keys(HANDLERS) as JobType[]
}
