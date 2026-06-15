import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { classifyTier, logClassificationStats, type EnrichedProspect } from '@/lib/sourcing/tier-classification'
import type { ICPFilterSpec } from '@/lib/agents/icp-filter-spec'

interface TieringRunResult {
  organisation_id: string
  prospects_classified: number
  tier_1_count: number
  tier_2_count: number
  tier_3_count: number
  untiered_count: number
  timestamp: string
  error?: string
}

export async function tierEnrichedBatch(
  supabase: SupabaseClient,
  organisationId: string,
  maxBatchSize: number = 100,
): Promise<TieringRunResult> {
  const operationId = `tier-${organisationId.slice(0, 8)}-${Date.now()}`

  logger.info('tiering-trigger: run started', {
    operation_id: operationId,
    organisation_id: organisationId,
    max_batch_size: maxBatchSize,
  })

  try {
    // ── Step 1: Read active approved ICP ──────────────────────────────────────
    const { data: icpDoc, error: icpError } = await supabase
      .from('strategy_documents')
      .select('id, icp_filter_spec')
      .eq('organisation_id', organisationId)
      .eq('document_type', 'icp')
      .eq('status', 'active')
      .eq('client_approval_status', 'approved')
      .single()

    if (icpError || !icpDoc?.icp_filter_spec) {
      logger.error('tiering-trigger: failed to load approved ICP or filter spec', {
        operation_id: operationId,
        organisation_id: organisationId,
        error: icpError?.message ?? 'ICP or filter spec is NULL',
      })
      throw new Error('Tiering failed: no approved ICP filter spec found')
    }

    const spec = icpDoc.icp_filter_spec as ICPFilterSpec

    // ── Step 2: Read TAM status ──────────────────────────────────────────────
    const { data: org, error: orgError } = await supabase
      .from('organisations')
      .select('tam_status, tam_override_reason')
      .eq('id', organisationId)
      .single()

    if (orgError || !org) {
      logger.error('tiering-trigger: failed to load organisation', {
        operation_id: operationId,
        organisation_id: organisationId,
        error: orgError?.message ?? 'Organisation not found',
      })
      throw new Error('Tiering failed: organisation not found')
    }

    const tamStatus = org.tam_status || null
    const tamOverrideReason = org.tam_override_reason || null

    logger.info('tiering-trigger: organisation context loaded', {
      operation_id: operationId,
      organisation_id: organisationId,
      tam_status: tamStatus,
      tier_3_allowed: tamStatus === 'amber' || (tamStatus === 'red' && !!tamOverrideReason),
    })

    // ── Step 3: Fetch enriched+untiered prospects ────────────────────────────
    const { data: prospects, error: prospectError } = await supabase
      .from('prospects')
      .select('id, organisation_id, email_status, enrichment_status, job_title, company_headcount, company_industry')
      .eq('organisation_id', organisationId)
      .eq('enrichment_status', 'enriched')
      .is('sourced_tier', null)
      .limit(maxBatchSize)

    if (prospectError) {
      logger.error('tiering-trigger: failed to fetch enriched prospects', {
        operation_id: operationId,
        organisation_id: organisationId,
        error: prospectError.message,
      })
      throw new Error(`Failed to fetch prospects: ${prospectError.message}`)
    }

    if (!prospects || prospects.length === 0) {
      logger.info('tiering-trigger: no untiered enriched prospects found', {
        operation_id: operationId,
        organisation_id: organisationId,
      })
      return {
        organisation_id: organisationId,
        prospects_classified: 0,
        tier_1_count: 0,
        tier_2_count: 0,
        tier_3_count: 0,
        untiered_count: 0,
        timestamp: new Date().toISOString(),
      }
    }

    logger.info('tiering-trigger: prospects fetched', {
      operation_id: operationId,
      organisation_id: organisationId,
      prospect_count: prospects.length,
    })

    // ── Step 4: Classify each prospect ───────────────────────────────────────
    const results = prospects.map(prospect =>
      classifyTier(
        prospect as EnrichedProspect,
        spec,
        tamStatus,
        tamOverrideReason,
      )
    )

    // ── Step 5: Update prospects with sourced_tier ──────────────────────────
    let updateCount = 0
    for (const result of results) {
      if (result.sourced_tier === null) {
        continue // Don't update untiered prospects (stay NULL)
      }

      const { error: updateError } = await supabase
        .from('prospects')
        .update({ sourced_tier: result.sourced_tier })
        .eq('id', result.prospect_id)
        .eq('organisation_id', organisationId)

      if (updateError) {
        logger.error('tiering-trigger: failed to update prospect tier', {
          operation_id: operationId,
          prospect_id: result.prospect_id,
          error: updateError.message,
        })
        throw new Error(`Failed to update prospect ${result.prospect_id}: ${updateError.message}`)
      }

      updateCount++
    }

    // ── Step 6: Log classification stats ────────────────────────────────────
    logClassificationStats(results, organisationId)

    const tier1Count = results.filter(r => r.sourced_tier === 'tier_1').length
    const tier2Count = results.filter(r => r.sourced_tier === 'tier_2').length
    const tier3Count = results.filter(r => r.sourced_tier === 'tier_3').length
    const untiedCount = results.filter(r => r.sourced_tier === null).length

    logger.info('tiering-trigger: run complete', {
      operation_id: operationId,
      organisation_id: organisationId,
      prospects_classified: results.length,
      tier_1_count: tier1Count,
      tier_2_count: tier2Count,
      tier_3_count: tier3Count,
      untiered_count: untiedCount,
      update_count: updateCount,
    })

    // ── Step 7: Return result ───────────────────────────────────────────────
    return {
      organisation_id: organisationId,
      prospects_classified: results.length,
      tier_1_count: tier1Count,
      tier_2_count: tier2Count,
      tier_3_count: tier3Count,
      untiered_count: untiedCount,
      timestamp: new Date().toISOString(),
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)

    logger.error('tiering-trigger: run failed', {
      operation_id: operationId,
      organisation_id: organisationId,
      error: errorMsg,
    })

    return {
      organisation_id: organisationId,
      prospects_classified: 0,
      tier_1_count: 0,
      tier_2_count: 0,
      tier_3_count: 0,
      untiered_count: 0,
      timestamp: new Date().toISOString(),
      error: errorMsg,
    }
  }
}
