import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { classifyTier, logClassificationStats, type EnrichedProspect } from '@/lib/sourcing/tier-classification'
import {
  loadIndustryTagMappings,
  mapApolloToSpecIndustryWithDatabase,
} from '@/lib/sourcing/industry-mapping'
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

    logger.info('tiering-trigger: organisation context loaded', {
      operation_id: operationId,
      organisation_id: organisationId,
    })

    // ── Step 3: Fetch enriched prospects that have never been classified ─────
    //
    // `sourced_tier IS NULL` ALONE IS NOT "not yet tiered". It is also every
    // prospect a disqualifier REMOVED, because a removed prospect keeps a NULL
    // tier forever: nothing in the codebase ever sets sourced_tier for one.
    //
    // Without the tiering_reason filter below, every run re-fetched and
    // re-classified all of them and rewrote the identical reason. That costs no
    // money, because classifyTier makes no API call, but it consumes the BATCH
    // CAP. At roughly 1,730 prospects a month with removals accumulating, a client
    // reaches the point where the cap is filled entirely by rows that were already
    // decided and tiering silently stops reaching newly enriched prospects. Silent
    // because the run still reports "completed, N classified": the number is real,
    // it is just N of the wrong prospects.
    //
    // tiering_reason is the discriminator because classifyTier writes one on EVERY
    // path, survivors included, and nothing else in the codebase writes that column
    // except the two operator re-tier routes, which set a tier at the same time.
    //
    // THE CONSEQUENCE, WHICH IS NOT FREE. This freezes a removal verdict: a removed
    // prospect is never re-examined by this path again. That is ADR-034's shape and
    // it is why this filter must never ship alone. Removals are put back in the
    // queue by persistIcpFilterSpec when a new ICP filter spec is stored, and by
    // nothing else. See ADR-037.
    const { data: prospects, error: prospectError } = await supabase
      .from('prospects')
      .select('id, organisation_id, email_status, enrichment_status, job_title, company_headcount, company_industry, company_name')
      .eq('organisation_id', organisationId)
      .eq('enrichment_status', 'enriched')
      .is('sourced_tier', null)
      .is('tiering_reason', null)
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
    const results = await Promise.all(
      prospects.map(prospect =>
        classifyTier(
          prospect as EnrichedProspect,
          spec,
          supabase,
        )
      )
    )

    // ── Step 5: Update prospects with sourced_tier and tier_published_at ────
    // If client_review_enabled = false, auto-publish and auto-approve at tiering time
    const tierPublishedAt = org.client_review_enabled === false ? new Date().toISOString() : null
    const clientReviewStatus = org.client_review_enabled === false ? 'approved' : null

    let updateCount = 0
    for (const result of results) {
      // Update ALL prospects with sourced_tier (may be null for flagged), fit_score, and tiering_reason
      const updatePayload: Record<string, unknown> = {
        sourced_tier: result.sourced_tier,
        fit_score: result.fit_score,
        tiering_reason: result.tiering_reason,
      }
      if (tierPublishedAt && result.sourced_tier !== null) {
        updatePayload.tier_published_at = tierPublishedAt
      }
      if (clientReviewStatus && result.sourced_tier !== null) {
        updatePayload.client_review_status = clientReviewStatus
      }

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

    // ── Step 6.5: Returned-industry assertion ───────────────────────────────
    //
    // THE OTHER HALF OF THE ORCHESTRATOR'S PRE-SEARCH GATE. That gate proves what
    // the query ASKED FOR. This one proves what CAME BACK, and the two are not the
    // same claim: Apollo silently ignores a parameter it does not recognise, so a
    // filter that reads correctly and passes the pre-search gate can still return
    // an unfiltered result. A parameter that stopped being honoured would look
    // exactly like one that never existed.
    //
    // THIS IS THE FIRST POINT IT CAN BE ASKED AT ALL. Sourcing candidates carry no
    // industry: the free api_search response carries `has_industry` as a boolean
    // and never the value (verified against the live API 2026-08-23, docs/BACKLOG.md),
    // and the orchestrator writes company_industry as NULL. The value arrives at
    // enrichment, from people/match, which is why this check lives here and not
    // upstream. The cost of that is real and worth stating: enrichment has already
    // been paid for by the time this fires.
    //
    // THE TRADE-OFF, DELIBERATE. There is no minimum batch size. A batch of one
    // off-specification prospect fails the run. That is noisier than a threshold
    // would be, and it is chosen because any threshold would be a number nobody has
    // measured, and a check that stays quiet below an invented floor is the shape
    // this whole change exists to remove.
    const specIndustries = Array.isArray(spec.industries) ? spec.industries : []

    if (specIndustries.length === 0) {
      logger.warn('tiering-trigger: ICP names no industries, returned rows are unchecked', {
        operation_id: operationId,
        organisation_id: organisationId,
        prospects_classified: results.length,
      })
    } else {
      let industryMappings: Record<string, string> = {}
      try {
        industryMappings = await loadIndustryTagMappings(supabase)
      } catch {
        // Static mappings only. The assertion still runs: falling back to a smaller
        // mapping table can only make a match HARDER to find, so it cannot turn a
        // real mismatch into a pass.
        industryMappings = {}
      }

      const specLower = new Set(specIndustries.map(i => String(i).toLowerCase()))

      // What actually came back, counted, so the failure message names it rather
      // than asserting a mismatch the operator then has to go and look up.
      const seen: Record<string, number> = {}
      let onSpecCount = 0
      let noIndustryCount = 0

      for (const prospect of prospects as EnrichedProspect[]) {
        const raw = prospect.company_industry
        if (!raw) {
          noIndustryCount++
          seen['(no industry)'] = (seen['(no industry)'] ?? 0) + 1
          continue
        }

        const mapped = mapApolloToSpecIndustryWithDatabase(raw, industryMappings)
        const label = mapped ?? `(unmapped) ${raw}`
        seen[label] = (seen[label] ?? 0) + 1

        if (mapped && specLower.has(mapped.toLowerCase())) {
          onSpecCount++
        }
      }

      if (onSpecCount === 0) {
        logger.error('tiering-trigger: no returned prospect matches a spec industry', {
          operation_id: operationId,
          organisation_id: organisationId,
          prospects_classified: results.length,
          spec_industries: specIndustries,
          returned_industries: seen,
          no_industry_count: noIndustryCount,
        })
        throw new Error(
          `Tiering failed for client ${organisationId}: not one of the ${results.length} enriched ` +
          'prospects in this batch has an industry the ICP asked for, so the sourcing query returned ' +
          'nothing on specification. ' +
          `ICP asked for: ${specIndustries.join(', ')}. ` +
          `Batch came back as: ${Object.entries(seen).map(([k, n]) => `${k} (${n})`).join(', ')}. ` +
          'Either the sourcing handler is searching for something other than what this ICP asks for, ' +
          'or a search parameter stopped being honoured and the query is no longer filtering.'
        )
      }

      logger.info('tiering-trigger: returned-industry assertion passed', {
        operation_id: operationId,
        organisation_id: organisationId,
        on_spec_count: onSpecCount,
        off_spec_count: results.length - onSpecCount,
        returned_industries: seen,
      })
    }

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
