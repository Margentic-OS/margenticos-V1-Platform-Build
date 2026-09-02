// Putting approved prospects into the enrichment queue.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE SELECTION PREDICATES ARE NO LONGER WRITTEN HERE
//
// They live in selectEnrichmentEligible, which this path and enrichApprovedBatch both
// call. Two copies of the same four predicates with a comment asking the next person to
// keep them in step is the parallel-array shape CLAUDE.md warns about: the copies drift,
// nothing errors, and flipping system_flags.queue_enrich quietly changes WHICH prospects
// get enriched rather than only HOW. Read that function for what eligible means and why.
//
// WHAT IS STILL DELIBERATELY ABSENT HERE: the enrichment_locked_at lock. In the queue
// path the QUEUE is the lock. job_queue's partial unique index already guarantees one
// live job per (job_type, prospect_id), and claim_jobs guarantees one worker per job.
// Carrying the old column-based lock as well would give one prospect two competing
// notions of "in progress" that could disagree. The inline path adds its own lock clause
// after calling the shared selector, and that difference is intended.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { enqueueJobsForProspects } from '../job-queue'
import {
  selectEnrichmentEligible,
  gateProspectsBeforeEnrichment,
  type SelectedProspect,
} from '@/lib/sourcing/enrichment-selection'

export interface EnqueueEnrichResult {
  ok: true
  selected: number
  created: number
  alreadyQueued: number
  /** Rejected by the client's buyer criterion before anything was queued or paid for. */
  rejectedBeforeSpend: number
  /** Operator-facing text when the buyer gate did not run. Null when it did. */
  buyerGateWarning: string | null
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
  const { data, error } = await selectEnrichmentEligible(supabase, organisationId)
    .limit(maxProspects)

  if (error) {
    return { ok: false, error: `Could not select prospects to enqueue: ${error.message}` }
  }

  const candidates = (data ?? []) as unknown as SelectedProspect[]

  if (candidates.length === 0) {
    logger.info('enqueue-enrich: nothing eligible', { organisation_id: organisationId })
    return {
      ok: true, selected: 0, created: 0, alreadyQueued: 0,
      rejectedBeforeSpend: 0, buyerGateWarning: null, organisationId,
    }
  }

  // The buyer gate runs BEFORE anything is queued, so a prospect this client would
  // never email is never enqueued and therefore never paid for.
  const gate = await gateProspectsBeforeEnrichment(supabase, organisationId, candidates)

  const prospectIds = gate.passed.map(p => p.id)

  if (prospectIds.length === 0) {
    logger.info('enqueue-enrich: nothing left after the buyer gate', {
      organisation_id: organisationId,
      rejected_before_spend: gate.rejected.length,
    })
    return {
      ok: true, selected: 0, created: 0, alreadyQueued: 0,
      rejectedBeforeSpend: gate.rejected.length,
      buyerGateWarning: gate.warning,
      organisationId,
    }
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
    rejected_before_spend: gate.rejected.length,
  })

  return {
    ok: true,
    selected: prospectIds.length,
    created: created.length,
    alreadyQueued: alreadyQueued.length,
    rejectedBeforeSpend: gate.rejected.length,
    buyerGateWarning: gate.warning,
    organisationId,
  }
}
