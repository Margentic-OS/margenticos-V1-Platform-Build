// Thin TypeScript wrappers over the job_queue database functions.
//
// Every one of these is a single RPC. The logic they wrap lives in SQL on purpose:
//
//   the atomic claim  needs FOR UPDATE SKIP LOCKED, which supabase-js cannot express
//                     through PostgREST
//   the backoff       is used by both fail and reclaim, and two copies of a retry
//                     formula drift apart
//   the retry policy  has to be evaluated against the row's own attempt count in the
//                     same statement that writes the new state, or two workers can
//                     read the same count and both decide to retry
//
// So this module deliberately contains almost no decisions. It marshals arguments,
// logs, and turns errors into thrown exceptions. Anything that looks like policy
// belongs in SQL or in execute-job.ts, not here.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { QUEUE_CONFIG, RECLAIM_BATCH_SIZE } from './config'
import type { ErrorClass, JobRow, JobType, OrganisationBacklog } from './types'

/** Add one job. Returns the row when it was created, null when one was already live. */
export async function enqueueJob(
  supabase: SupabaseClient,
  params: {
    jobType: JobType
    organisationId: string
    prospectId: string
    enqueuedBy: string
    maxAttempts?: number
  },
): Promise<JobRow | null> {
  const { data, error } = await supabase.rpc('enqueue_job', {
    p_job_type:        params.jobType,
    p_organisation_id: params.organisationId,
    p_prospect_id:     params.prospectId,
    p_enqueued_by:     params.enqueuedBy,
    p_max_attempts:    params.maxAttempts ?? QUEUE_CONFIG[params.jobType].maxAttempts,
  })

  if (error) throw new Error(`enqueue_job failed: ${error.message}`)

  // An empty result is the ON CONFLICT DO NOTHING path: this prospect already has a
  // live job of this type. That is a successful no-op, never an error. Distinguishing
  // it by whether a row came back is what keeps double clicks and retried requests
  // from creating duplicate paid work.
  const rows = (data ?? []) as JobRow[]
  return rows.length > 0 ? rows[0] : null
}

/**
 * Add one job for a research BATCH PHASE. Returns the row when it was created, null when
 * a live research job of any kind already exists for this prospect.
 *
 * ── WHY THIS IS NOT enqueueJob ──
 *
 * enqueue_job absorbs duplicates with `ON CONFLICT (job_type, prospect_id) DO NOTHING`.
 * That clause names ONE index, and the protection the batch phases need spans job types:
 * a prospect waiting 24 hours in research_collect must not accept a new
 * research_sources job, and the two rows differ in job_type so the per-type index does
 * not see them as duplicates.
 *
 * The database enforces the wider rule with job_queue_one_live_research_per_prospect.
 * Because enqueue_job's ON CONFLICT does not name that index, a violation of it raises
 * out of enqueue_job rather than being absorbed, which would abort a whole enqueue loop
 * part-way through. So the batch phases call enqueue_research_phase instead, which
 * catches unique_violation and returns zero rows.
 *
 * enqueue_job itself is deliberately UNCHANGED. The single-job research path depends on
 * it and that path is the rollback.
 */
export async function enqueueResearchPhaseJob(
  supabase: SupabaseClient,
  params: {
    jobType: 'research_sources' | 'research_collect'
    organisationId: string
    prospectId: string
    enqueuedBy: string
    maxAttempts?: number
  },
): Promise<JobRow | null> {
  const { data, error } = await supabase.rpc('enqueue_research_phase', {
    p_job_type:        params.jobType,
    p_organisation_id: params.organisationId,
    p_prospect_id:     params.prospectId,
    p_enqueued_by:     params.enqueuedBy,
    p_max_attempts:    params.maxAttempts ?? QUEUE_CONFIG[params.jobType].maxAttempts,
  })

  if (error) throw new Error(`enqueue_research_phase failed: ${error.message}`)

  // Same contract as enqueueJob: an empty result means a live research job already
  // exists for this prospect. A successful no-op, never an error.
  const rows = (data ?? []) as JobRow[]
  return rows.length > 0 ? rows[0] : null
}

/**
 * Which prospects already have a live job somewhere in the research family.
 *
 * Used to give an operator a sentence instead of a 23505. The database index is the
 * guarantee; this is the courtesy. Both are needed: without the index a race gets
 * through, and without this the abort message is a Postgres error code.
 */
export async function prospectsWithLiveResearchJob(
  supabase: SupabaseClient,
  organisationId: string,
  prospectIds: string[],
): Promise<Set<string>> {
  if (prospectIds.length === 0) return new Set()

  const { data, error } = await supabase
    .from('job_queue')
    .select('prospect_id, job_type')
    .eq('organisation_id', organisationId)
    .in('job_type', ['research', 'research_sources', 'research_collect'])
    .in('state', ['queued', 'claimed'])
    .in('prospect_id', prospectIds)

  if (error) {
    // FAIL LOUD. Returning an empty set on error would silently disable the guard and
    // let an enqueue proceed straight into a duplicate-paid-work situation, which is the
    // exact thing the guard exists to stop. A thrown error is recoverable; a silent
    // re-spend on Apify, Apollo and Brave is not.
    throw new Error(`Could not check for live research jobs: ${error.message}`)
  }

  return new Set((data ?? []).map(row => row.prospect_id as string))
}

/**
 * Enqueue many prospects for one organisation.
 *
 * Reports created and alreadyQueued separately, because "nothing happened because it
 * was all already queued" and "nothing happened because something is broken" must not
 * look the same to the caller.
 */
export async function enqueueJobsForProspects(
  supabase: SupabaseClient,
  params: {
    jobType: JobType
    organisationId: string
    prospectIds: string[]
    enqueuedBy: string
  },
): Promise<{ created: JobRow[]; alreadyQueued: string[] }> {
  const created: JobRow[] = []
  const alreadyQueued: string[] = []

  for (const prospectId of params.prospectIds) {
    const row = await enqueueJob(supabase, {
      jobType:        params.jobType,
      organisationId: params.organisationId,
      prospectId,
      enqueuedBy:     params.enqueuedBy,
    })
    if (row) created.push(row)
    else alreadyQueued.push(prospectId)
  }

  logger.info('job-queue: enqueue batch complete', {
    job_type:        params.jobType,
    organisation_id: params.organisationId,
    requested:       params.prospectIds.length,
    created:         created.length,
    already_queued:  alreadyQueued.length,
  })

  return { created, alreadyQueued }
}

/**
 * Atomically take up to `limit` queued jobs for one organisation.
 *
 * Two workers calling this concurrently receive DISJOINT sets: the underlying statement
 * is a single UPDATE ... RETURNING whose subquery uses FOR UPDATE SKIP LOCKED, so the
 * second transaction skips the rows the first has locked instead of blocking on them.
 */
export async function claimJobs(
  supabase: SupabaseClient,
  params: {
    jobType: JobType
    organisationId: string
    worker: string
    limit?: number
    leaseSeconds?: number
  },
): Promise<JobRow[]> {
  const config = QUEUE_CONFIG[params.jobType]

  const { data, error } = await supabase.rpc('claim_jobs', {
    p_job_type:        params.jobType,
    p_organisation_id: params.organisationId,
    p_worker:          params.worker,
    p_lease_seconds:   params.leaseSeconds ?? config.leaseSeconds,
    p_limit:           params.limit ?? config.claimBatchSize,
  })

  if (error) throw new Error(`claim_jobs failed: ${error.message}`)
  return (data ?? []) as JobRow[]
}

/** Organisations with claimable work, oldest job first. The fairness input. */
export async function getOrganisationBacklog(
  supabase: SupabaseClient,
  jobType: JobType,
): Promise<OrganisationBacklog[]> {
  const { data, error } = await supabase.rpc('queue_next_organisations', {
    p_job_type: jobType,
  })

  if (error) throw new Error(`queue_next_organisations failed: ${error.message}`)
  return (data ?? []) as OrganisationBacklog[]
}

/**
 * Stamp a job as paid for. MUST be called the instant an external paid call returns,
 * BEFORE any parsing, mapping or database write that can throw.
 *
 * NEVER THROWS. This runs in the window between the money leaving and the work being
 * recorded, which is precisely the window the 3de0589 bug lived in. An exception here
 * would abort the one write that exists to prevent paying twice, so both the RPC error
 * and any unexpected throw are logged and swallowed.
 *
 * Returns whether the stamp was written, for logging only. Callers must not branch on
 * it: a failed stamp is a serious problem, but refusing to continue would abandon work
 * we have already paid for.
 */
export async function recordJobSpend(
  supabase: SupabaseClient,
  jobId: string,
  detail: Record<string, unknown>,
): Promise<boolean> {
  try {
    const { error } = await supabase.rpc('record_job_spend', {
      p_job_id: jobId,
      p_detail: detail,
    })

    if (error) {
      logger.error('job-queue: FAILED TO RECORD SPEND after a paid call returned', {
        job_id: jobId,
        detail,
        error: error.message,
        consequence:
          'This job is not marked as paid for. If the worker dies before it finishes, ' +
          'the reclaim will treat it as unpaid and may call the paid API again.',
      })
      return false
    }

    logger.info('job-queue: spend recorded', { job_id: jobId, detail })
    return true
  } catch (err) {
    logger.error('job-queue: recordJobSpend threw, job continues', {
      job_id: jobId,
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

/**
 * Mark a claimed job finished.
 *
 * FENCED to the lease holder. Returns null when this worker no longer holds the claim,
 * which means its lease expired and the job was reclaimed by someone else while it was
 * still working. That is not an error to throw on: it is information the caller needs,
 * because the work it just did is not recorded and another worker is redoing it.
 */
export async function completeJob(
  supabase: SupabaseClient,
  jobId: string,
  worker: string,
  summary: string,
): Promise<JobRow | null> {
  const { data, error } = await supabase.rpc('complete_job', {
    p_job_id:  jobId,
    p_worker:  worker,
    p_summary: summary.slice(0, 900),
  })

  if (error) throw new Error(`complete_job failed: ${error.message}`)
  const rows = (data ?? []) as JobRow[]
  return rows.length > 0 ? rows[0] : null
}

/**
 * Record a failure. The database decides what happens next from the error class and
 * the row's own attempt count.
 *
 * forceTerminal is for the one case that is neither a permanent API error nor an
 * exhausted attempt count: a reclaimed job that already has spend recorded. It must
 * never be retried, because retrying means paying twice.
 *
 * FENCED to the lease holder, for a sharper reason than completeJob. Without the fence
 * a stalled worker could push a job another worker is actively running back to
 * 'queued', where a third worker claims it and pays for the same prospect again.
 */
export async function failJob(
  supabase: SupabaseClient,
  jobId: string,
  worker: string,
  errorText: string,
  errorClass: ErrorClass,
  forceTerminal = false,
): Promise<JobRow | null> {
  const { data, error } = await supabase.rpc('fail_job', {
    p_job_id:         jobId,
    p_worker:         worker,
    p_error:          errorText.slice(0, 900),
    p_error_class:    errorClass,
    p_force_terminal: forceTerminal,
  })

  if (error) throw new Error(`fail_job failed: ${error.message}`)
  const rows = (data ?? []) as JobRow[]
  return rows.length > 0 ? rows[0] : null
}

/**
 * Put dead workers' jobs back, or terminate them if their attempts are used up.
 *
 * Called at the START of every worker invocation, before claiming, so a job stranded by
 * the previous tick becomes available in this one.
 */
export async function reclaimExpiredJobs(
  supabase: SupabaseClient,
  limit: number = RECLAIM_BATCH_SIZE,
): Promise<JobRow[]> {
  const { data, error } = await supabase.rpc('reclaim_expired_jobs', { p_limit: limit })

  if (error) throw new Error(`reclaim_expired_jobs failed: ${error.message}`)
  const rows = (data ?? []) as JobRow[]

  if (rows.length > 0) {
    logger.warn('job-queue: reclaimed jobs from expired leases', {
      count:      rows.length,
      terminated: rows.filter(r => r.state === 'failed').length,
      requeued:   rows.filter(r => r.state === 'queued').length,
      // Named so a repeating worker death is visible without opening the table.
      job_ids:    rows.slice(0, 20).map(r => r.id),
    })
  }

  return rows
}

/** How many jobs of this type are currently claimed, across all workers. The pacing read. */
export async function countInFlight(
  supabase: SupabaseClient,
  jobType: JobType,
): Promise<number> {
  const { count, error } = await supabase
    .from('job_queue')
    .select('id', { count: 'exact', head: true })
    .eq('job_type', jobType)
    .eq('state', 'claimed')

  if (error) throw new Error(`countInFlight failed: ${error.message}`)
  return count ?? 0
}

// ═════════════════════════════════════════════════════════════════════════════
// ROTATION CURSOR
//
// Read before planning a pass, written after. See the header of fairness.ts for why
// ordering by oldest job is not on its own a round-robin, and queue_rotation in
// 20260824170000 for why the cursor lives in its own table rather than in worker memory.

/** Which organisation the previous pass finished on. Null when the rotation is fresh. */
export async function getRotationCursor(
  supabase: SupabaseClient,
  jobType: JobType,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('queue_rotation')
    .select('last_organisation_id')
    .eq('job_type', jobType)
    .maybeSingle()

  if (error) {
    // A missing cursor is not a reason to skip a pass. Starting from the oldest is the
    // same behaviour the planner has for an unrecognised cursor, and losing one tick of
    // rotation is far cheaper than doing no work at all.
    logger.warn('job-queue: could not read rotation cursor, starting from the oldest', {
      job_type: jobType,
      error: error.message,
    })
    return null
  }

  return (data?.last_organisation_id as string | null) ?? null
}

/**
 * Record where this pass stopped, so the next one starts after it.
 *
 * NEVER THROWS. A cursor that fails to save costs one tick of rotation, which is a
 * fairness hiccup. Aborting the worker over it would cost the whole tick's work.
 */
export async function setRotationCursor(
  supabase: SupabaseClient,
  jobType: JobType,
  organisationId: string,
): Promise<void> {
  try {
    const { error } = await supabase
      .from('queue_rotation')
      .update({ last_organisation_id: organisationId, updated_at: new Date().toISOString() })
      .eq('job_type', jobType)

    if (error) {
      logger.warn('job-queue: could not save rotation cursor, next pass may repeat this one', {
        job_type: jobType,
        organisation_id: organisationId,
        error: error.message,
      })
    }
  } catch (err) {
    logger.warn('job-queue: setRotationCursor threw, next pass may repeat this one', {
      job_type: jobType,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
