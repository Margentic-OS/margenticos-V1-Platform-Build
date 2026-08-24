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

/** One flag key per job type. The rows are seeded by 20260824160000_job_queue.sql. */
export const QUEUE_FLAG_KEYS: Record<JobType, string> = {
  enrich:   'queue_enrich',
  research: 'queue_research',
  compose:  'queue_compose',
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

  const { error } = await supabase.from('system_flags').update(update).eq('key', key)

  if (error) {
    throw new Error(`Failed to set ${key} to ${enabled}: ${error.message}`)
  }

  logger.info('queue-flags: flag updated', {
    flag_key: key,
    job_type: jobType,
    enabled,
    updated_by: updatedBy,
  })
}
