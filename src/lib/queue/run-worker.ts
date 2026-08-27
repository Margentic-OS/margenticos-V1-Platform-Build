// One pass of the durable job queue.
//
// Extracted from the route so it can be tested without an HTTP layer. The route owns
// auth, the Sentry check-in and the heartbeat; this owns the work.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS FINISHES INSIDE 300s RATHER THAN RESUMING MID-JOB
//
// A research job is one continuous chain of paid calls: two Apify actors, then
// synthesis, then write, then judge. Measured at 46.8s per prospect of wall clock at
// concurrency 5, one prospect occupies roughly 156 to 234 seconds of its own time.
//
// Making that resumable would mean persisting every intermediate Apify and Anthropic
// result and re-entering the chain partway, which reopens the double-spend surface the
// lease exists to close: a half-finished job has to decide, per step, whether that step
// was already paid for.
//
// So each invocation FINISHES what it claims. It takes a deadline budget and stops
// claiming once the time left cannot fit another worst-case job of that type. A worker
// that dies anyway is handled by the lease, not by resumption: reclaim_expired_jobs puts
// the row back and the attempt cap eventually terminates it.
//
// The cost of that choice is that a death loses the work in flight and burns one
// attempt. The benefit is that there is exactly one place where "have we already paid"
// is asked, and it is spend_recorded_at.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { QUEUE_CONFIG, WORKER_BUDGET_SECONDS } from './config'
import { planClaimsWithRotation, inFlightHeadroom } from './fairness'
import { isQueueEnabled, setQueueFlag } from './flags'
import { getHandlerFactory, type JobBatchExecutor } from './handlers'
import {
  claimJobs,
  countInFlight,
  getOrganisationBacklog,
  getRotationCursor,
  reclaimExpiredJobs,
  setRotationCursor,
} from './job-queue'
import { JOB_TYPES, type JobType } from './types'

/**
 * How many jobs in one pass may fail with an account-exhaustion error before the job
 * type is switched off.
 *
 * TWO, not one. A single 402 could be a transient billing blip or a misread message, and
 * turning a client's whole pipeline off on one reading is too eager. Two in the same
 * pass, against an account-level signal, is a dry account rather than a coincidence.
 *
 * The breaker exists because account exhaustion is not a per-job problem: retrying 3,333
 * jobs against a dry Apify or Apollo account is "never loop on a paid API" happening at
 * scale instead of per job. The attempt cap bounds one job; only this bounds the fleet.
 */
export const EXHAUSTION_TRIP_THRESHOLD = 2

export interface JobTypeResult {
  enabled: boolean
  handlerRegistered: boolean
  claimed: number
  done: number
  failed: number
  /** Finished work whose completion write failed or whose lease had been taken. */
  unrecorded: number
  organisationsServed: number
  inFlightAtStart: number
  headroom: number
  /** Set when the credit-exhaustion breaker turned this job type off. */
  circuitBreakerTripped: boolean
  /** Ran out of invocation budget before the backlog was exhausted. */
  budgetExhausted: boolean
  errors: string[]
}

export interface WorkerRunResult {
  ok: boolean
  workerId: string
  elapsedSeconds: number
  reclaimed: number
  reclaimTerminated: number
  byJobType: Record<JobType, JobTypeResult>
  errors: string[]
}

function emptyResult(): JobTypeResult {
  return {
    enabled: false,
    handlerRegistered: false,
    claimed: 0,
    done: 0,
    failed: 0,
    unrecorded: 0,
    organisationsServed: 0,
    inFlightAtStart: 0,
    headroom: 0,
    circuitBreakerTripped: false,
    budgetExhausted: false,
    errors: [],
  }
}

export interface RunWorkerOptions {
  supabase: SupabaseClient
  /**
   * Identifies this invocation. Written to claimed_by and REQUIRED by the fenced
   * complete_job and fail_job, so a worker whose lease was reclaimed cannot touch a row
   * that now belongs to someone else.
   */
  workerId: string
  /** Injectable for tests. Defaults to the real clock. */
  now?: () => number
  budgetSeconds?: number
  /**
   * How the worker finds the executor for a job type. Defaults to the real registry.
   *
   * Injectable because the alternative is spying on an ESM named export, which binds at
   * import time and is not reliably observable from inside this module. A test that
   * spied on it passed alone and failed in the full suite, which is the worst kind of
   * test: one whose result depends on what else ran.
   */
  resolveExecutor?: (jobType: JobType) => JobBatchExecutor | null
}

export async function runWorker({
  supabase,
  workerId,
  now = Date.now,
  budgetSeconds = WORKER_BUDGET_SECONDS,
  resolveExecutor = getHandlerFactory,
}: RunWorkerOptions): Promise<WorkerRunResult> {
  const startedAt = now()
  const elapsed = () => (now() - startedAt) / 1000
  const errors: string[] = []

  // DERIVED FROM JOB_TYPES, NOT WRITTEN OUT. This was a hand-written literal of three
  // keys cast with `as Record<JobType, JobTypeResult>`, and the cast is what made it
  // dangerous: without it, an incomplete literal is a compile error, which is precisely
  // the check that would have caught a new job type. With it, adding a job type left
  // byJobType[jobType] undefined and the loop below crashed on `result.enabled` at
  // runtime, inside a try/catch that recorded it as "job type pass threw".
  //
  // Same family as the monitor-sweep arrays: a second list that has to be kept in step
  // with the first by hand, where forgetting produces no error at the point of the
  // mistake. Building it from JOB_TYPES means the drift cannot be expressed.
  const byJobType = Object.fromEntries(
    JOB_TYPES.map(jobType => [jobType, emptyResult()]),
  ) as Record<JobType, JobTypeResult>

  // ── Reclaim first, before claiming anything ─────────────────────────────────
  //
  // A job stranded by the previous tick becomes available in this one. Running this
  // before the claims is what makes a dead worker's work recoverable within a single
  // tick rather than waiting for a later pass to notice.
  let reclaimed = 0
  let reclaimTerminated = 0
  try {
    const rows = await reclaimExpiredJobs(supabase)
    reclaimed = rows.length
    reclaimTerminated = rows.filter(r => r.state === 'failed').length
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    errors.push(`reclaim failed: ${msg}`)
    logger.error('queue-worker: reclaim failed, continuing to claim', { error: msg })
  }

  // ── One job type at a time ──────────────────────────────────────────────────
  for (const jobType of JOB_TYPES) {
    const result = byJobType[jobType]
    const config = QUEUE_CONFIG[jobType]

    try {
      result.enabled = await isQueueEnabled(supabase, jobType)
      result.handlerRegistered = resolveExecutor(jobType) !== null

      if (!result.enabled) continue

      // Enabled with nothing able to run it. Work would pile up in the queue with no
      // other symptom, so this is a run failure rather than a quiet skip.
      if (!result.handlerRegistered) {
        const msg =
          `${jobType} is enabled in system_flags but no handler is registered in ` +
          'src/lib/queue/handlers.ts, so its jobs cannot be executed by this deployment. ' +
          'Either deploy the handler or turn the flag off.'
        result.errors.push(msg)
        errors.push(msg)
        logger.error('queue-worker: job type enabled with no handler', { job_type: jobType })
        continue
      }

      // ── Pacing ──────────────────────────────────────────────────────────────
      result.inFlightAtStart = await countInFlight(supabase, jobType)
      result.headroom = inFlightHeadroom(config, result.inFlightAtStart)
      if (result.headroom <= 0) continue

      const backlog = await getOrganisationBacklog(supabase, jobType)
      if (backlog.length === 0) continue

      const cursor = await getRotationCursor(supabase, jobType)
      const plan = planClaimsWithRotation(backlog, config, result.headroom, cursor)
      if (plan.entries.length === 0) continue

      let exhaustionHits = 0

      for (const entry of plan.entries) {
        // ── The deadline budget ───────────────────────────────────────────────
        //
        // Checked BEFORE claiming, never after. Claiming a job this invocation cannot
        // finish would mark it claimed, hold its lease for the full lease window, and
        // leave it stranded until reclaim — for work that was never started.
        if (elapsed() + config.worstCaseSeconds > budgetSeconds) {
          result.budgetExhausted = true
          logger.info('queue-worker: stopping claims, not enough budget for another job', {
            job_type: jobType,
            elapsed_seconds: Math.round(elapsed()),
            worst_case_seconds: config.worstCaseSeconds,
            budget_seconds: budgetSeconds,
          })
          break
        }

        const claimed = await claimJobs(supabase, {
          jobType,
          organisationId: entry.organisation_id,
          worker: workerId,
          limit: entry.limit,
        })

        if (claimed.length === 0) continue

        result.claimed += claimed.length
        result.organisationsServed += 1
        await setRotationCursor(supabase, jobType, entry.organisation_id)

        // The executor owns the whole claimed batch. For enrichment that is one Apollo
        // bulk_match call covering up to ten prospects; for the per-job types it is
        // perJobExecutor mapping executeJob across them concurrently. Either way it
        // returns one outcome per job and never throws, so one batch cannot stop the
        // rest of the pass.
        const executor = resolveExecutor(jobType)!
        const outcomes = await executor(supabase, claimed, workerId)

        for (const outcome of outcomes) {
          if (outcome.status === 'done') result.done += 1
          else if (outcome.status === 'failed') {
            result.failed += 1
            if (outcome.accountExhausted) exhaustionHits += 1
          } else {
            // completion_write_failed and lease_lost. The work happened; only the record
            // of it did not. Counted apart from failures so the heartbeat does not read
            // a bookkeeping problem as a work problem.
            result.unrecorded += 1
          }
        }

        // ── The circuit breaker ───────────────────────────────────────────────
        if (exhaustionHits >= EXHAUSTION_TRIP_THRESHOLD) {
          const msg =
            `${jobType} disabled automatically: ${exhaustionHits} jobs in one pass failed with ` +
            'an account-exhaustion error, which means the provider account is out of credit or ' +
            'quota. Retrying every queued job against a dry account would burn attempts for ' +
            'nothing. Top the account up and set the flag back to true.'
          result.circuitBreakerTripped = true
          result.errors.push(msg)
          errors.push(msg)
          logger.error('queue-worker: circuit breaker tripped, job type disabled', {
            job_type: jobType,
            exhaustion_hits: exhaustionHits,
          })

          try {
            await setQueueFlag(supabase, jobType, false, 'circuit-breaker:account-exhausted', msg)
          } catch (err) {
            // setQueueFlag throws when it matched zero rows, which would mean the breaker
            // did NOT fire. That is worse than the exhaustion itself and must be loud.
            const flagMsg =
              `${jobType} circuit breaker FAILED to disable the job type: ` +
              (err instanceof Error ? err.message : String(err))
            result.errors.push(flagMsg)
            errors.push(flagMsg)
            logger.error('queue-worker: circuit breaker could not turn the flag off', {
              job_type: jobType,
              error: flagMsg,
            })
          }
          break
        }
      }
    } catch (err) {
      // One job type failing must not stop the others.
      const msg = err instanceof Error ? err.message : String(err)
      result.errors.push(msg)
      errors.push(`${jobType}: ${msg}`)
      logger.error('queue-worker: job type pass threw', { job_type: jobType, error: msg })
    }
  }

  // ── The ok rule ─────────────────────────────────────────────────────────────
  //
  // ok is false when ANY error was recorded anywhere: a reclaim failure, a job type
  // enabled with no handler, a job type whose pass threw, a tripped circuit breaker, or
  // a breaker that failed to fire.
  //
  // Individual job FAILURES do not make the run not-ok. A job that fails for its own
  // reasons, retries, and eventually terminates is the queue working correctly, and a
  // heartbeat that went red on every terminal job would be red permanently and therefore
  // useless. Job failure rates are watched by MON-018 instead, which is the instrument
  // shaped for a rate rather than an event.
  //
  // This value drives all three instruments together: the DB heartbeat, the Sentry
  // check-in, and the HTTP response. MON-002 derives its state from staleness alone and
  // never reads ok, so a job that runs and fails every time reads OK there. The queue
  // monitors below do not inherit that.
  const ok = errors.length === 0

  return {
    ok,
    workerId,
    elapsedSeconds: Math.round(elapsed()),
    reclaimed,
    reclaimTerminated,
    byJobType,
    errors,
  }
}
