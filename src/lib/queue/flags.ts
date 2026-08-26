// Queue rollout flags. Explicit database values, never inferred.
//
// Per CLAUDE.md, mode is never derived from NODE_ENV, VERCEL_URL, or the presence or
// absence of an API key. An inferred mode cannot be audited, cannot be changed without
// a deploy, and drifts silently from whatever the UI claims. Same discipline as
// enrichment_live in src/lib/sourcing/enrichment-mode.ts.
//
// FAIL CLOSED TO THE INLINE PATH. Every failure mode here returns false, which means
// "keep running the existing inline code". That is the safe direction: the inline path
// is the one that has been running in production. A flag read that errors must never
// silently switch execution onto the new machinery.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
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
 * Should this job type go through the queue?
 *
 * false means run the existing inline path. That is the default, the seeded value, and
 * the answer to every error.
 */
export async function isQueueEnabled(
  supabase: SupabaseClient,
  jobType: JobType,
): Promise<boolean> {
  const key = QUEUE_FLAG_KEYS[jobType]

  try {
    const { data, error } = await supabase
      .from('system_flags')
      .select('enabled')
      .eq('key', key)
      .maybeSingle()

    if (error) {
      logger.warn('queue-flags: could not read flag, falling back to the inline path', {
        flag_key: key,
        job_type: jobType,
        error: error.message,
      })
      return false
    }

    // A missing row is not an error. It means the flag was never seeded, and the
    // correct reading of "no instruction" is "do what we did before".
    if (!data) {
      logger.warn('queue-flags: flag row missing, falling back to the inline path', {
        flag_key: key,
        job_type: jobType,
      })
      return false
    }

    return data.enabled === true
  } catch (err) {
    logger.error('queue-flags: threw while reading flag, falling back to the inline path', {
      flag_key: key,
      job_type: jobType,
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
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
