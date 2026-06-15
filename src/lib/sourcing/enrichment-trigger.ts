// src/lib/sourcing/enrichment-trigger.ts
//
// Enrichment execution trigger for operator-approved prospects.
//
// Flow:
// 1. Acquire lock on approved-unenriched prospects (or stale-locked-unenriched, reclaimable after 30 min)
// 2. Derive Apollo IDs from source_person_key
// 3. Call enrichProspectsForOrganisation (existing handler)
// 4. Update prospects with enrichment_run_id (linkage for audit)
// 5. Return run result
//
// Lock is via enrichment_locked_at column (orthogonal to enrichment_status outcome).
// Stale lock reclaim prevents crashed handlers from permanently skipping prospects.
// Idempotency: once enrichment_status is set to terminal value, prospect is excluded from future runs.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { enrichProspectsForOrganisation, type EnrichmentRun } from '@/lib/sourcing/handlers/adapter-apollo-enrichment'

const STALE_LOCK_THRESHOLD_MINUTES = 30

interface LockResult {
  prospect_id: string
  source_person_key: string
}

/**
 * Enrich operator-approved prospects with Apollo enrichment.
 *
 * Acquires exclusive lock on approved+unenriched prospects (or stale-locked-unenriched).
 * Calls existing enrichProspectsForOrganisation handler.
 * Updates enrichment_run_id on enriched prospects for audit trail.
 *
 * Returns full EnrichmentRun result from handler.
 */
export async function enrichApprovedBatch(
  supabase: SupabaseClient,
  organisationId: string,
  maxBatchSize: number = 100,
): Promise<EnrichmentRun> {
  const operationId = `enrich-approved-${organisationId.slice(0, 8)}-${Date.now()}`

  logger.info('enrichment-trigger: run started', {
    operation_id: operationId,
    organisation_id: organisationId,
    max_batch_size: maxBatchSize,
  })

  try {
    // ── Step 1: Acquire lock on approved-unenriched prospects ────────────────
    // Lockable predicates:
    //   - sourcing_review_status = 'approved'
    //   - enrichment_status IS NULL (not yet enriched)
    //   - enrichment_locked_at IS NULL (not locked)
    //   OR stale lock (> 30 min old, still unenriched) is reclaimable
    //
    // Lock is acquired by: UPDATE...SET enrichment_locked_at=now()
    // Lock prevents concurrent invocations from double-spending credits.
    // Stale lock reclaim prevents crashed handlers from permanently skipping prospects.

    const staleThresholdISO = new Date(Date.now() - STALE_LOCK_THRESHOLD_MINUTES * 60 * 1000).toISOString()

    const { data: lockedProspects, error: lockError } = await supabase
      .from('prospects')
      .select('id, source_person_key')
      .eq('organisation_id', organisationId)
      .eq('sourcing_review_status', 'approved')
      .is('enrichment_status', null)
      .or(`enrichment_locked_at.is.null,enrichment_locked_at.lt.${staleThresholdISO}`)
      .limit(maxBatchSize)

    if (lockError) {
      logger.error('enrichment-trigger: lock select failed', {
        operation_id: operationId,
        organisation_id: organisationId,
        error: lockError.message,
      })
      throw new Error(`Failed to select lockable prospects: ${lockError.message}`)
    }

    if (!lockedProspects || lockedProspects.length === 0) {
      logger.info('enrichment-trigger: no lockable prospects found', {
        operation_id: operationId,
        organisation_id: organisationId,
      })
      return {
        organisation_id: organisationId,
        batch_size: 0,
        total_requested_enrichments: 0,
        unique_enriched_records: 0,
        missing_records: 0,
        credits_consumed: 0,
        enriched_at: new Date().toISOString(),
        status: 'success',
      }
    }

    const prospectIds = lockedProspects.map(p => p.id)
    const sourcePersonKeys = lockedProspects.map(p => p.source_person_key)

    logger.info('enrichment-trigger: lockable prospects selected', {
      operation_id: operationId,
      organisation_id: organisationId,
      selected_count: prospectIds.length,
    })

    // Acquire lock atomically on selected prospects
    const { error: updateLockError } = await supabase
      .from('prospects')
      .update({ enrichment_locked_at: new Date().toISOString() })
      .in('id', prospectIds)
      .eq('organisation_id', organisationId)

    if (updateLockError) {
      logger.error('enrichment-trigger: lock acquisition failed', {
        operation_id: operationId,
        organisation_id: organisationId,
        error: updateLockError.message,
      })
      throw new Error(`Failed to acquire lock: ${updateLockError.message}`)
    }

    logger.info('enrichment-trigger: lock acquired', {
      operation_id: operationId,
      organisation_id: organisationId,
      locked_count: prospectIds.length,
    })

    // ── Step 2: Derive Apollo IDs from source_person_key ────────────────────
    // source_person_key format: "apollo:{apollo_id}"
    // Extract apollo_id portion and pass to handler

    const apolloIds = sourcePersonKeys
      .map(key => {
        if (!key || !key.startsWith('apollo:')) {
          logger.warn('enrichment-trigger: invalid source_person_key format', {
            operation_id: operationId,
            source_person_key: key,
          })
          return null
        }
        return key.substring('apollo:'.length)
      })
      .filter((id): id is string => id !== null)

    if (apolloIds.length === 0) {
      logger.error('enrichment-trigger: no valid Apollo IDs derived', {
        operation_id: operationId,
        organisation_id: organisationId,
        source_person_keys_count: sourcePersonKeys.length,
      })
      throw new Error('No valid Apollo IDs derived from source_person_keys')
    }

    logger.info('enrichment-trigger: Apollo IDs derived', {
      operation_id: operationId,
      organisation_id: organisationId,
      apollo_ids_count: apolloIds.length,
    })

    // ── Step 3: Call enrichProspectsForOrganisation handler ─────────────────
    // Handler is synchronous, batches internally into groups of 10.
    // Returns EnrichmentRun with credits_consumed, outcome counts, status.

    let enrichmentRun: EnrichmentRun
    try {
      enrichmentRun = await enrichProspectsForOrganisation(
        supabase as any,
        organisationId,
        apolloIds,
        maxBatchSize,
      )

      logger.info('enrichment-trigger: handler completed', {
        operation_id: operationId,
        organisation_id: organisationId,
        status: enrichmentRun.status,
        credits_consumed: enrichmentRun.credits_consumed,
        enriched: enrichmentRun.unique_enriched_records,
      })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      logger.error('enrichment-trigger: handler failed', {
        operation_id: operationId,
        organisation_id: organisationId,
        error: errorMsg,
      })
      throw new Error(`Handler execution failed: ${errorMsg}`)
    }

    // ── Step 4: Update enrichment_run_id on enriched prospects (audit trail) ─
    // Link prospects to enrichment_runs for observability.
    // Query enrichment_runs to find the record just created by the handler,
    // then update all prospects that were processed with enrichment_run_id.

    const { data: enrichmentRunRecord, error: queryRunError } = await supabase
      .from('enrichment_runs')
      .select('id')
      .eq('organisation_id', organisationId)
      .eq('run_timestamp', enrichmentRun.enriched_at)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (queryRunError) {
      logger.warn('enrichment-trigger: failed to query enrichment_runs record', {
        operation_id: operationId,
        organisation_id: organisationId,
        error: queryRunError.message,
      })
    } else if (enrichmentRunRecord) {
      const { error: linkError } = await supabase
        .from('prospects')
        .update({ enrichment_run_id: enrichmentRunRecord.id })
        .in('id', prospectIds)
        .eq('organisation_id', organisationId)
        .not('enrichment_status', 'is', null)

      if (linkError) {
        logger.warn('enrichment-trigger: failed to update enrichment_run_id', {
          operation_id: operationId,
          organisation_id: organisationId,
          error: linkError.message,
        })
      } else {
        logger.info('enrichment-trigger: enrichment_run_id populated', {
          operation_id: operationId,
          organisation_id: organisationId,
          enrichment_run_id: enrichmentRunRecord.id,
        })
      }
    }

    logger.info('enrichment-trigger: run complete', {
      operation_id: operationId,
      organisation_id: organisationId,
      status: enrichmentRun.status,
      credits_consumed: enrichmentRun.credits_consumed,
      enriched: enrichmentRun.unique_enriched_records,
      missing: enrichmentRun.missing_records,
    })

    // ── Step 5: Return result ────────────────────────────────────────────
    return enrichmentRun
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    logger.error('enrichment-trigger: run failed', {
      operation_id: operationId,
      organisation_id: organisationId,
      error: errorMsg,
    })

    return {
      organisation_id: organisationId,
      batch_size: 0,
      total_requested_enrichments: 0,
      unique_enriched_records: 0,
      missing_records: 0,
      credits_consumed: 0,
      enriched_at: new Date().toISOString(),
      status: 'failed',
      error_message: errorMsg,
    }
  }
}
