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
// The two research batch phases registered 2026-08-26, both flags still false.
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

import type { SupabaseClient } from '@supabase/supabase-js'
import { executeJob, type JobHandler, type JobOutcome } from './execute-job'
import { enrichBatchExecutor } from './executors/enrich'
import { researchHandler } from './executors/research'
import { researchSourcesHandler } from './executors/research-sources'
import { researchCollectHandler } from './executors/research-collect'
import type { JobRow, JobType } from './types'

/**
 * Runs one CLAIMED BATCH to terminal states and reports an outcome per job.
 *
 * ── WHY THE UNIT IS A BATCH AND NOT A SINGLE JOB ──
 *
 * Apollo's people/bulk_match takes TEN people per HTTP call and reports one
 * credits_consumed figure for the whole call. An executor that could only see one job at
 * a time would have to issue ten calls where one would do: ten times the requests against
 * a 600/hour ceiling, for identical cost in credits.
 *
 * So the contract is batch-shaped, and the per-job case is expressed in terms of it by
 * perJobExecutor below rather than the other way round. That keeps one code path in the
 * worker instead of a special case for enrichment.
 *
 * Every executor must return exactly one JobOutcome per job it was given, and must never
 * throw: the worker runs many batches per invocation and one batch failing must not stop
 * the others.
 */
export type JobBatchExecutor = (
  supabase: SupabaseClient,
  jobs: JobRow[],
  workerId: string,
) => Promise<JobOutcome[]>

/**
 * Turns a per-job handler into a batch executor, for job types whose work is genuinely
 * one prospect at a time.
 *
 * Jobs run concurrently. executeJob never throws, so one prospect failing writes to its
 * own row and cannot affect its neighbours.
 */
export function perJobExecutor(
  handlerFor: (job: JobRow) => JobHandler,
): JobBatchExecutor {
  return (supabase, jobs, workerId) =>
    Promise.all(jobs.map(job => executeJob(supabase, job, workerId, handlerFor(job))))
}

const HANDLERS: Partial<Record<JobType, JobBatchExecutor>> = {
  // C4. Batch-shaped: one Apollo bulk_match call per claimed batch of up to ten.
  enrich: enrichBatchExecutor,
  // C5. Genuinely per-prospect, so perJobExecutor maps executeJob across the claimed
  // batch and each prospect gets its own row, its own spend stamp and its own verdict.
  research: perJobExecutor(() => researchHandler()),
  // compose:  registered in C6

  // ── THE BATCH PATH. Both registered together, on purpose. ─────────────────
  //
  // research_sources is only useful if research_collect can run, because phase 1 leaves a
  // prospect mid-flight with its sources already bought. Deploying the first without the
  // second would mean a flag flip could strand paid-for work with no code able to finish
  // it, and the worker would report the honest but useless "enabled with no handler".
  //
  // Both flags remain false until a live batch proves the path. A handler that is
  // deployed and waiting is the normal state, not a half-finished one.
  research_sources: perJobExecutor(() => researchSourcesHandler()),
  research_collect: perJobExecutor(() => researchCollectHandler()),
}

/** The executor for a job type, or null when none is deployed yet. */
export function getHandlerFactory(jobType: JobType): JobBatchExecutor | null {
  return HANDLERS[jobType] ?? null
}

/** Which job types this deployment can actually execute. */
export function registeredJobTypes(): JobType[] {
  return Object.keys(HANDLERS) as JobType[]
}
