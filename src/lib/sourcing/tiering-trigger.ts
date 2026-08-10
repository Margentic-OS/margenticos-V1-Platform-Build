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
  agent_run_id?: string
  error?: string
}

export async function tierEnrichedBatch(
  supabase: SupabaseClient,
  organisationId: string,
  maxBatchSize: number = 100,
): Promise<TieringRunResult> {
  const operationId = `tier-${organisationId.slice(0, 8)}-${Date.now()}`
  const startedAt = new Date()

  logger.info('tiering-trigger: run started', {
    operation_id: operationId,
    organisation_id: organisationId,
    max_batch_size: maxBatchSize,
  })

  // ── Step 0: Create agent_runs record to track this execution ─────────────────
  let agentRunId: string = ''
  const { data: agentRun, error: agentRunError } = await supabase
    .from('agent_runs')
    .insert({
      organisation_id: organisationId,
      agent_name: 'tiering-trigger',
      status: 'running',
      started_at: startedAt.toISOString(),
      output_summary: null,
      error_message: null,
    })
    .select('id')
    .single()

  if (agentRunError || !agentRun) {
    logger.error('tiering-trigger: failed to create agent_runs record', {
      operation_id: operationId,
      organisation_id: organisationId,
      error: agentRunError?.message ?? 'Unknown error',
    })
    // Continue anyway - agent_runs creation failure should not block tiering
  } else {
    agentRunId = agentRun.id
    logger.info('tiering-trigger: agent_runs record created', {
      operation_id: operationId,
      agent_run_id: agentRunId,
    })
  }

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

    // ── Step 2: Read review gate config (TAM status optional) ──────────────────
    const { data: org, error: orgError } = await supabase
      .from('organisations')
      .select('id, client_review_enabled')
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

    // TAM status fields are optional (may not exist in schema yet)
    const tamStatus = null
    const tamOverrideReason = null

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

      // ── Update agent_runs record to completed (no work) ──────────────────
      const endedAt = new Date()
      const durationMs = endedAt.getTime() - startedAt.getTime()

      if (agentRunId) {
        const { error: updateRunError } = await supabase
          .from('agent_runs')
          .update({
            status: 'completed',
            completed_at: endedAt.toISOString(),
            duration_ms: durationMs,
            output_summary: 'No untiered enriched prospects found',
          })
          .eq('id', agentRunId)

        if (updateRunError) {
          logger.error('tiering-trigger: failed to update agent_runs record', {
            operation_id: operationId,
            agent_run_id: agentRunId,
            error: updateRunError.message,
          })
        }
      }

      return {
        organisation_id: organisationId,
        prospects_classified: 0,
        tier_1_count: 0,
        tier_2_count: 0,
        tier_3_count: 0,
        untiered_count: 0,
        timestamp: new Date().toISOString(),
        agent_run_id: agentRunId,
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

    // ── Step 5: Update prospects with sourced_tier and tier_published_at ────
    // If client_review_enabled = false, auto-publish and auto-approve at tiering time
    const tierPublishedAt = org.client_review_enabled === false ? new Date().toISOString() : null
    const clientReviewStatus = org.client_review_enabled === false ? 'approved' : null

    let updateCount = 0
    for (const result of results) {
      if (result.sourced_tier === null) {
        continue // Don't update untiered prospects (stay NULL)
      }

      const updatePayload: Record<string, unknown> = { sourced_tier: result.sourced_tier }
      if (tierPublishedAt) updatePayload.tier_published_at = tierPublishedAt
      if (clientReviewStatus) updatePayload.client_review_status = clientReviewStatus

      const { error: updateError } = await supabase
        .from('prospects')
        .update(updatePayload)
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

    // ── Step 7: Update agent_runs record to completed ─────────────────────
    const endedAt = new Date()
    const durationMs = endedAt.getTime() - startedAt.getTime()
    const outputSummary = `Classified ${results.length} prospects: ${tier1Count} Tier 1, ${tier2Count} Tier 2, ${tier3Count} Tier 3, ${untiedCount} untiered`

    if (agentRunId) {
      const { error: updateRunError } = await supabase
        .from('agent_runs')
        .update({
          status: 'completed',
          completed_at: endedAt.toISOString(),
          duration_ms: durationMs,
          output_summary: outputSummary,
        })
        .eq('id', agentRunId)

      if (updateRunError) {
        logger.error('tiering-trigger: failed to update agent_runs record', {
          operation_id: operationId,
          agent_run_id: agentRunId,
          error: updateRunError.message,
        })
      }
    }

    // ── Step 8: Return result ───────────────────────────────────────────────
    return {
      organisation_id: organisationId,
      prospects_classified: results.length,
      tier_1_count: tier1Count,
      tier_2_count: tier2Count,
      tier_3_count: tier3Count,
      untiered_count: untiedCount,
      timestamp: new Date().toISOString(),
      agent_run_id: agentRunId,
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)

    logger.error('tiering-trigger: run failed', {
      operation_id: operationId,
      organisation_id: organisationId,
      error: errorMsg,
    })

    // ── Update agent_runs record to failed ─────────────────────────────────
    const endedAt = new Date()
    const durationMs = endedAt.getTime() - startedAt.getTime()

    if (agentRunId) {
      const { error: updateRunError } = await supabase
        .from('agent_runs')
        .update({
          status: 'failed',
          completed_at: endedAt.toISOString(),
          duration_ms: durationMs,
          error_message: errorMsg,
        })
        .eq('id', agentRunId)

      if (updateRunError) {
        logger.error('tiering-trigger: failed to update agent_runs record on error', {
          operation_id: operationId,
          agent_run_id: agentRunId,
          error: updateRunError.message,
        })
      }
    }

    return {
      organisation_id: organisationId,
      prospects_classified: 0,
      tier_1_count: 0,
      tier_2_count: 0,
      tier_3_count: 0,
      untiered_count: 0,
      timestamp: new Date().toISOString(),
      agent_run_id: agentRunId,
      error: errorMsg,
    }
  }
}
