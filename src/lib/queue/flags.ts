// Queue rollout flags. Explicit database values, never inferred.
//
// Per CLAUDE.md, mode is never derived from NODE_ENV, VERCEL_URL, or the presence or
// absence of an API key. An inferred mode cannot be audited, cannot be changed without
// a deploy, and drifts silently from whatever the UI claims. Same discipline as
// enrichment_live in src/lib/sourcing/enrichment-mode.ts.
//
// ─── A SWITCH THAT CANNOT BE READ IS NOT A SWITCH THAT IS OFF. Changed 2026-09-11. ───
//
// This module used to "fail closed to the inline path": every failure returned false. That
// was written when the inline path was the proven one and the queue was new, and the reason
// was sound: a flag read that errors must never silently switch execution ONTO new
// machinery.
//
// It stopped being safe once the worker read the same switch to decide whether to run a job
// type at all. For the worker, false does not mean "use the proven path", it means "skip this
// job type this minute". So every failed read silently skipped a minute of work and logged a
// warning nobody reads. Measured 2026-09-11: this read was cut by Supabase's gateway with a
// 504 forty times in 24 hours, and none of those skips reached Sentry.
//
// So a failed read now REPORTS TO SENTRY AND THROWS. The original guarantee still holds,
// because nothing switches onto new machinery when nothing proceeds at all, and the silent
// skip is gone. Every caller already has somewhere a throw lands:
//
//   queue worker          records it as that job type's failure, still runs the other
//                         types, and marks the run not ok, which reaches the heartbeat
//   research and enrich   the operator gets a 500 naming the switch, instead of the request
//   operator routes       quietly running down the inline path
//   synthesis sweep       reports a failed run instead of a deliberate idle
//   pipeline review       fails its read instead of showing a research path it does not know
//
// STILL false, and quiet: a row that says enabled = false. That is a genuine off.
// STILL false, with a warning: no row at all. The read succeeded and found no instruction,
// which is a configuration state rather than an outage. See the note in isQueueEnabled.

import * as Sentry from '@sentry/nextjs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { describeQueryFailure } from '@/lib/supabase/describe-query-failure'
import type { JobType } from './types'

/**
 * One flag key per job type.
 *
 * enrich/research/compose are seeded by 20260824160000_job_queue.sql; the two research
 * batch phases by 20260826130000_research_batch_job_types.sql.
 *
 * ── THE TWO BATCH KEYS ARE NOT SYMMETRIC. READ THIS BEFORE FLIPPING EITHER. ──
 *
 * queue_research_sources is THE SWITCH. It decides, at ENQUEUE time, whether new work
 * goes down the batch path or the existing single-job 'research' path. It is mutually
 * exclusive with queue_research, enforced by system_flags_research_path_exclusive, so
 * turning it on requires turning the old one off and vice versa. That exclusion is also
 * what keeps Apify actor concurrency inside its measured ceiling of 25.
 *
 * queue_research_collect is A DRAIN VALVE, and turning it off is NOT how you roll back.
 * Phase 2 collects synthesis results that have ALREADY BEEN PAID FOR. Turning this off
 * while batches are in flight strands them: the money is spent, the results sit in
 * Anthropic's store for 29 days, and no job will ever read them.
 *
 * TO ROLL BACK: set queue_research_sources false and queue_research true. Leave
 * queue_research_collect ON until every in-flight batch has drained. New work goes down
 * the proven path immediately; work already paid for still finishes.
 *
 * The flag is read at ENQUEUE, not at claim, precisely so a mid-batch flip cannot
 * strand a prospect between phases with no path forward.
 */
export const QUEUE_FLAG_KEYS: Record<JobType, string> = {
  enrich:           'queue_enrich',
  research:         'queue_research',
  compose:          'queue_compose',
  research_sources: 'queue_research_sources',
  research_collect: 'queue_research_collect',
}

/**
 * Thrown when a switch cannot be READ. That is a different fact from a switch that is off,
 * and nothing in this module turns one into the other.
 */
export class QueueFlagUnreadableError extends Error {
  readonly flagKey: string
  readonly jobType: JobType

  constructor(flagKey: string, jobType: JobType, cause: string) {
    super(
      `Queue switch ${flagKey} could not be read, so whether ${jobType} should run is unknown. ` +
      `Nothing was decided and nothing ran on its behalf. Cause: ${cause}`,
    )
    this.name = 'QueueFlagUnreadableError'
    this.flagKey = flagKey
    this.jobType = jobType
  }
}

// Reported HERE, once, rather than left to each caller. Of the five callers only two report
// errors to Sentry themselves, so a throw that relied on the caller would still be silent on
// the other three.
function unreadable(flagKey: string, jobType: JobType, cause: string): QueueFlagUnreadableError {
  const err = new QueueFlagUnreadableError(flagKey, jobType, cause)
  logger.error('queue-flags: switch could not be read, refusing to decide', {
    flag_key: flagKey,
    job_type: jobType,
    error: cause,
  })
  Sentry.captureException(err, {
    tags: { component: 'queue-flags', flag_key: flagKey, job_type: jobType },
  })
  return err
}

/**
 * Should this job type go through the queue?
 *
 *   true    the row says enabled = true
 *   false   the row says anything else, or there is no row
 *   throws  QueueFlagUnreadableError when the row could not be read at all
 */
export async function isQueueEnabled(
  supabase: SupabaseClient,
  jobType: JobType,
): Promise<boolean> {
  const key = QUEUE_FLAG_KEYS[jobType]

  let data: { enabled?: unknown } | null
  try {
    const result = await supabase
      .from('system_flags')
      .select('enabled')
      .eq('key', key)
      .maybeSingle()

    // The whole result, not just the error: this read failing as a 504 is the case that
    // prompted the change, and the status is on the result rather than on the error.
    if (result.error) throw unreadable(key, jobType, describeQueryFailure(result))
    data = result.data
  } catch (err) {
    if (err instanceof QueueFlagUnreadableError) throw err
    throw unreadable(key, jobType, err instanceof Error ? err.message : String(err))
  }

  // A missing row is NOT a failed read. The read succeeded and found no instruction, which
  // means the flag was never seeded, and "no instruction" reads as "not switched on". It is a
  // configuration state rather than an outage, so it warns rather than throws. The
  // QUEUE_FLAG_KEYS tests guard the one way it could appear by accident: a job type with a key
  // that no migration seeds.
  if (!data) {
    logger.warn('queue-flags: flag row missing, treating the job type as switched off', {
      flag_key: key,
      job_type: jobType,
    })
    return false
  }

  // Strict === true. A truthy string must not switch a money-spending path on.
  return data.enabled === true
}

/**
 * Turn a job type's queue on or off.
 *
 * Called by an operator action and by the worker's credit-exhaustion circuit breaker,
 * which is why updated_by is required rather than optional: an automatic flip that
 * does not say it was automatic is indistinguishable from a person having done it, and
 * the first question when a queue stops is always "who turned this off".
 */
export async function setQueueFlag(
  supabase: SupabaseClient,
  jobType: JobType,
  enabled: boolean,
  updatedBy: string,
  note?: string,
): Promise<void> {
  const key = QUEUE_FLAG_KEYS[jobType]

  const update: Record<string, unknown> = {
    enabled,
    updated_at: new Date().toISOString(),
    updated_by: updatedBy,
  }
  if (note !== undefined) update.note = note

  // .select() is what makes this verifiable. A bare .update().eq() returns error: null
  // when it matched ZERO rows, so a missing or misnamed flag row reported success while
  // changing nothing.
  //
  // THAT MATTERS MORE HERE THAN ANYWHERE ELSE IN THE QUEUE. This function is the
  // credit-exhaustion circuit breaker. If it can silently fail to flip, the breaker does
  // not exist: the worker would believe it had stopped the job type and keep hammering a
  // dry Apollo or Apify account until the attempt caps ran out across every queued job.
  const { data, error } = await supabase
    .from('system_flags')
    .update(update)
    .eq('key', key)
    .select('key')

  if (error) {
    throw new Error(`Failed to set ${key} to ${enabled}: ${error.message}`)
  }

  if (!data || data.length === 0) {
    throw new Error(
      `Failed to set ${key} to ${enabled}: no system_flags row matched that key. ` +
      'The flag was NOT changed. If this was the credit-exhaustion circuit breaker, the ' +
      'job type is still running. Seed the row with the migration in ' +
      '20260824160000_job_queue.sql.',
    )
  }

  logger.info('queue-flags: flag updated', {
    flag_key: key,
    job_type: jobType,
    enabled,
    updated_by: updatedBy,
  })
}
