// Putting approved prospects into the enrichment queue.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE SELECTION PREDICATES ARE THE SAME ONES enrichApprovedBatch USES, AND MUST STAY SO
//
// This is the queue-path twin of the lock-and-select block in
// src/lib/sourcing/enrichment-trigger.ts. While both paths exist behind the flag, a
// prospect must be eligible under exactly one definition, or flipping the flag would
// change WHICH prospects get enriched rather than only HOW.
//
//   sourcing_review_status = 'approved'      the operator approved this prospect
//   enrichment_status IS NULL                no verdict has been reached yet
//   enrichment_credit_consumed_at IS NULL    we have never paid Apollo for this person
//
// The third predicate is the one that is easy to leave out and expensive to forget. It
// exists because the first is written at the END of a run and the money leaves at the
// START, so a run that died in between leaves a prospect that looks untouched. It is
// what stopped the 30-minute stale-lock reclaim re-buying contacts: Aug 10 2026, 141
// credits for 29 prospects.
//
// WHAT IS DELIBERATELY ABSENT: the enrichment_locked_at lock. In the queue path the
// QUEUE is the lock. job_queue's partial unique index already guarantees one live job
// per (job_type, prospect_id), and claim_jobs guarantees one worker per job. Carrying
// the old column-based lock as well would give one prospect two competing notions of
// "in progress" that could disagree.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { enqueueJobsForProspects } from '../job-queue'

export interface EnqueueEnrichResult {
  ok: true
  selected: number
  created: number
  alreadyQueued: number
  organisationId: string
}

/**
 * Queue every approved, unenriched, never-paid-for prospect in one organisation.
 *
 * Idempotent by construction: enqueue_job collapses on the partial unique index, so
 * clicking twice queues each prospect once. alreadyQueued is reported separately so
 * "nothing happened because it was all already queued" does not look like "nothing
 * happened because something is broken".
 */
export async function enqueueEnrichForOrganisation(
  supabase: SupabaseClient,
  organisationId: string,
  enqueuedBy: string,
  maxProspects = 500,
): Promise<EnqueueEnrichResult | { ok: false; error: string }> {
  const { data, error } = await supabase
    .from('prospects')
    .select('id')
    .eq('organisation_id', organisationId)
    .eq('sourcing_review_status', 'approved')
    .is('enrichment_status', null)
    .is('enrichment_credit_consumed_at', null)
    .limit(maxProspects)

  if (error) {
    return { ok: false, error: `Could not select prospects to enqueue: ${error.message}` }
  }

  const prospectIds = (data ?? []).map(r => r.id as string)

  if (prospectIds.length === 0) {
    logger.info('enqueue-enrich: nothing eligible', { organisation_id: organisationId })
    return { ok: true, selected: 0, created: 0, alreadyQueued: 0, organisationId }
  }

  const { created, alreadyQueued } = await enqueueJobsForProspects(supabase, {
    jobType: 'enrich',
    organisationId,
    prospectIds,
    enqueuedBy,
  })

  logger.info('enqueue-enrich: complete', {
    organisation_id: organisationId,
    selected: prospectIds.length,
    created: created.length,
    already_queued: alreadyQueued.length,
  })

  return {
    ok: true,
    selected: prospectIds.length,
    created: created.length,
    alreadyQueued: alreadyQueued.length,
    organisationId,
  }
}
