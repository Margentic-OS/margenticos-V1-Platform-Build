// Running one job safely.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE TWO THINGS THIS FILE EXISTS TO GUARANTEE
//
// 1. A JOB THAT HAS ALREADY BEEN PAID FOR NEVER CALLS THE PAID API AGAIN.
//
//    A lease makes a dead worker's job reclaimable, which is what stops work being
//    stranded forever. But reclaim is also exactly how money gets spent twice: the
//    Apollo re-spend fixed in 3de0589 was a crash mid-job that left the work claimable
//    and payable twice, because the money left at the START of the run and the outcome
//    was written at the END. On 10 August 2026 that cost 141 credits for 29 prospects,
//    against a ceiling of one per contact.
//
//    So a claimed job carrying spend_recorded_at is refused before the handler is ever
//    invoked. It goes terminal with a named reason. We cannot reconstruct a response we
//    already paid for, and calling again is the bug itself. A terminal failure that
//    says why is honest; a silent retry is not.
//
// 2. RECORDING SPEND IS STRUCTURAL, NOT REMEMBERED.
//
//    Handlers do not call recordJobSpend themselves. They call paid(), which invokes
//    the external API and records the spend the instant it returns, BEFORE the result
//    is handed back and therefore before any parsing, mapping or database write that
//    could throw. A handler physically cannot reach a paid API through this context
//    without the stamp being written first.
//
//    That is the difference between a rule and a mechanism. The rule was already
//    written down before 10 August 2026 and it was still possible to violate it.
//
// ═════════════════════════════════════════════════════════════════════════════
// A KNOWN, DELIBERATE LIMITATION. DO NOT "FIX" THIS.
//
// paid() records spend AFTER call() resolves. So there is one window it does not
// cover: the provider received the request and billed for it, and the response never
// came back. A 504 from a gateway, or an ECONNRESET, after Apollo has already debited
// the credits. No stamp is written, the error classifies as transient, the job is
// requeued, and the paid call happens again.
//
// THE OBVIOUS FIX IS WORSE THAN THE PROBLEM. Stamping BEFORE the call makes every
// transient failure look paid. A 429 is a request the provider received, rejected, and
// charged nothing for. So are ECONNREFUSED, a DNS failure, and a connect timeout. Under
// a pre-call stamp every one of those would hit the gate on retry and be terminated as
// already-paid, which destroys the retry behaviour that invariant E exists to provide.
// It would trade a rare duplicate charge for routine, silent loss of work.
//
// There is no third option from the client side. Telling "billed but the answer was
// lost" apart from "never billed" requires either a provider-side idempotency key,
// which Apollo's people/bulk_match does not offer, or a reconciliation read against the
// provider's own usage record. Both are separate features, not a tightening of this one.
//
// WHAT IS ACTUALLY BOUNDED HERE. This is the ordinary at-least-once ambiguity of any
// queue over a non-idempotent paid API, and it is capped by max_attempts (3 for enrich,
// 2 for research). It is structurally different from the 3de0589 bug, where money left
// at the START and status was written at the END, so EVERY ordinary failure in between
// re-paid: a mapping miss, a parse error, a database write failure, a worker death.
// That deterministic every-run re-spend is what produced 141 credits for 29 prospects.
// This is a rare tail, not a loop.
//
// Reviewed adversarially on 2026-08-24 and left in place on purpose.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { classifyError, describeError, isAccountExhaustion } from './error-classification'
import { completeJob, failJob, recordJobSpend } from './job-queue'
import type { ErrorClass, JobRow } from './types'

/** Whether a claimed job may run at all. */
export type ExecutionDecision =
  | { action: 'run' }
  | { action: 'terminate'; reason: string }

/**
 * The gate. Pure, so it can be tested without a database or a network.
 *
 * A job arrives here already claimed. The only question is whether running it could
 * spend money we have already spent.
 */
export function decideExecution(job: JobRow): ExecutionDecision {
  if (job.spend_recorded_at !== null) {
    return {
      action: 'terminate',
      reason:
        `Refusing to run job ${job.id}: spend was already recorded at ${job.spend_recorded_at} ` +
        `on a previous attempt (attempt ${job.attempts} of ${job.max_attempts}). ` +
        'An external paid call already returned for this job, so running it again would ' +
        'pay for the same work twice. The paid response cannot be reconstructed, so this ' +
        'job stops here rather than retrying.',
    }
  }
  return { action: 'run' }
}

/**
 * What a handler is given. The ONLY route to an external paid API.
 */
export interface JobContext {
  readonly job: JobRow

  /**
   * Make an external call that costs money.
   *
   * The spend stamp is written as soon as `call` resolves and before this function
   * returns, so every failure path in the handler after this point is already covered.
   *
   * `describeSpend` turns the response into the detail stored on the row. It is
   * invoked inside a guard: if it throws, the stamp is still written, with the error
   * noted instead of the detail. Losing the description is survivable. Losing the
   * stamp is not.
   */
  paid<T>(
    label: string,
    call: () => Promise<T>,
    describeSpend?: (result: T) => Record<string, unknown>,
  ): Promise<T>
}

/** A job handler. Returns a one-line summary for job_queue.result_summary. */
export type JobHandler = (ctx: JobContext) => Promise<string>

export type JobOutcome =
  | { status: 'done'; jobId: string; summary: string }
  /**
   * The work finished but the completion write threw. NOT a failure: the external call
   * is done and paid for. The lease lapses and reclaim requeues; the spend gate stops
   * the next attempt from paying again.
   */
  | { status: 'completion_write_failed'; jobId: string; summary: string }
  /**
   * The work finished but this worker's lease had already been reclaimed, so the fence
   * rejected the completion write. Another worker owns the row and is redoing it.
   */
  | { status: 'lease_lost'; jobId: string; summary: string }
  | {
      status: 'failed'
      jobId: string
      error: string
      errorClass: ErrorClass
      /** Terminal because the row already carried a spend stamp, not because of an API error. */
      terminatedForSpend: boolean
      /** The account is out of money or quota. The worker trips its circuit breaker on this. */
      accountExhausted: boolean
    }

/**
 * Run one claimed job to a terminal state.
 *
 * NEVER THROWS. The worker runs many jobs per invocation and one job's failure must not
 * abort its neighbours, so every exit path here returns a JobOutcome. Even a failure to
 * WRITE the failure is caught: the job is left claimed, its lease lapses, and reclaim
 * picks it up, which is the correct degradation.
 */
export async function executeJob(
  supabase: SupabaseClient,
  job: JobRow,
  worker: string,
  handler: JobHandler,
): Promise<JobOutcome> {
  // ── The spend gate, before anything else ────────────────────────────────────
  const decision = decideExecution(job)
  if (decision.action === 'terminate') {
    logger.error('execute-job: refusing to re-run a job that was already paid for', {
      job_id:            job.id,
      job_type:          job.job_type,
      organisation_id:   job.organisation_id,
      prospect_id:       job.prospect_id,
      attempts:          job.attempts,
      spend_recorded_at: job.spend_recorded_at,
      spend_detail:      job.spend_detail,
    })

    await safeFail(supabase, job, worker, decision.reason, 'permanent', true)

    return {
      status:             'failed',
      jobId:              job.id,
      error:              decision.reason,
      errorClass:         'permanent',
      terminatedForSpend: true,
      accountExhausted:   false,
    }
  }

  // ── The paid-call wrapper handed to the handler ─────────────────────────────
  const ctx: JobContext = {
    job,
    async paid<T>(
      label: string,
      call: () => Promise<T>,
      describeSpend?: (result: T) => Record<string, unknown>,
    ): Promise<T> {
      const result = await call()

      // THE MONEY IS GONE AS OF THE LINE ABOVE. Nothing between here and the stamp may
      // be allowed to throw.
      let detail: Record<string, unknown>
      try {
        detail = { label, ...(describeSpend ? describeSpend(result) : {}) }
      } catch (err) {
        detail = {
          label,
          describe_spend_failed: err instanceof Error ? err.message : String(err),
        }
      }

      await recordJobSpend(supabase, job.id, detail)
      return result
    },
  }

  // ── Run it ──────────────────────────────────────────────────────────────────
  //
  // THE HANDLER AND THE COMPLETION WRITE ARE IN SEPARATE TRY BLOCKS, and that separation
  // is the whole of fix F.
  //
  // They used to share one. So a throw from completeJob was caught by the handler's
  // catch, classified as if the WORK had failed, and written through safeFail. The
  // result: a job that ran to completion, paid its external API, and produced its output
  // was recorded as failed. If the class came out transient it would then be retried and
  // pay again; if permanent it was terminal, and the successful work was thrown away
  // with a misleading reason attached.
  //
  // A handler failure and a bookkeeping failure are different events with different
  // correct responses, so they cannot share a catch.
  let summary: string
  try {
    summary = await handler(ctx)
  } catch (err) {
    const errorClass = classifyError(err)
    const errorText  = describeError(err)
    const exhausted  = isAccountExhaustion(err)

    // A handler that failed AFTER paying is not a re-spend risk on this attempt, but it
    // will be refused on the next one by the gate above. Logged explicitly because the
    // combination is the exact 3de0589 shape and it should be visible when it happens.
    logger.error('execute-job: job failed', {
      job_id:           job.id,
      job_type:         job.job_type,
      organisation_id:  job.organisation_id,
      prospect_id:      job.prospect_id,
      attempts:         job.attempts,
      max_attempts:     job.max_attempts,
      error_class:      errorClass,
      account_exhausted: exhausted,
      error:            errorText,
    })

    await safeFail(supabase, job, worker, errorText, errorClass, false)

    return {
      status:             'failed',
      jobId:              job.id,
      error:              errorText,
      errorClass,
      terminatedForSpend: false,
      accountExhausted:   exhausted,
    }
  }

  // ── The work succeeded. Now record it. ──────────────────────────────────────
  //
  // A failure from here on is a BOOKKEEPING failure, never a work failure. The external
  // call is done and paid for and its output is written. Marking the job failed now
  // would be a lie that costs money on retry.
  try {
    const completed = await completeJob(supabase, job.id, worker, summary)

    if (completed === null) {
      // Zero rows matched, which means the fence rejected us: this worker's lease
      // expired and the job was reclaimed while the handler was still running. The work
      // IS done, but another worker now owns the row and is redoing it.
      //
      // Not marked failed, because it did not fail. Not marked done either, because we
      // no longer hold the claim and overwriting the new holder's row is exactly the
      // corruption the fence exists to stop.
      logger.error('execute-job: work finished but the lease had already been reclaimed', {
        job_id:          job.id,
        job_type:        job.job_type,
        organisation_id: job.organisation_id,
        prospect_id:     job.prospect_id,
        worker,
        attempts:        job.attempts,
        consequence:
          'Another worker holds this job and will redo it. If the handler made a paid ' +
          'call, spend_recorded_at is set and the spend gate will terminate that attempt ' +
          'rather than paying again.',
        fix: 'Raise leaseSeconds for this job type if this recurs.',
      })
      return { status: 'lease_lost', jobId: job.id, summary }
    }

    logger.info('execute-job: job complete', {
      job_id:          job.id,
      job_type:        job.job_type,
      organisation_id: job.organisation_id,
      prospect_id:     job.prospect_id,
      attempts:        job.attempts,
    })

    return { status: 'done', jobId: job.id, summary }
  } catch (err) {
    // The completion write itself threw. The job stays 'claimed', its lease lapses, and
    // reclaim requeues it. If the handler paid for anything, the spend gate terminates
    // that next attempt instead of paying twice. Deliberately NOT routed through
    // safeFail: this job did not fail.
    logger.error('execute-job: work succeeded but the completion write failed', {
      job_id:          job.id,
      job_type:        job.job_type,
      organisation_id: job.organisation_id,
      prospect_id:     job.prospect_id,
      worker,
      summary,
      error: err instanceof Error ? err.message : String(err),
      consequence:
        'Job stays claimed until its lease expires, then reclaim requeues it. It is NOT ' +
        'marked failed, because the work was done.',
    })
    return { status: 'completion_write_failed', jobId: job.id, summary }
  }
}

/**
 * Write a failure without ever throwing.
 *
 * If this cannot record the failure, the job stays 'claimed' and its lease lapses.
 * reclaim_expired_jobs then picks it up and applies the attempt cap, so the job still
 * reaches a terminal state eventually. Throwing here instead would abort the worker's
 * remaining jobs, which breaks the isolation guarantee for a database blip.
 */
async function safeFail(
  supabase: SupabaseClient,
  job: JobRow,
  worker: string,
  errorText: string,
  errorClass: ErrorClass,
  forceTerminal: boolean,
): Promise<void> {
  try {
    await failJob(supabase, job.id, worker, errorText, errorClass, forceTerminal)
  } catch (err) {
    logger.error('execute-job: could not write the failure, leaving the lease to lapse', {
      job_id: job.id,
      original_error: errorText,
      write_error: err instanceof Error ? err.message : String(err),
      consequence:
        'Job stays claimed until its lease expires, then reclaim applies the attempt cap.',
    })
  }
}
