// Prospect Research Agent v2
// Run with: npx tsx --env-file=.env.local src/lib/agents/prospect-research-agent-v2.ts
//
// Architecture: all four sources run in parallel → single synthesis step → store.
// Sources: LinkedIn (Apify), Apollo, company website, web search.
// Output: prospect_research_results row + updated prospects columns.
// Classification: icp_fit (strong/moderate/weak) + has_dateable_signal (bool) + signal_relevance (use_as_hook/ignore).
// v1 agent (prospect-research-agent.ts) remains in place until v2 is dogfooded end-to-end.

import fs from 'fs'
import path from 'path'
import readline from 'readline'
import pLimit from 'p-limit'
import { createClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { startAgentRun } from '@/lib/agents/log-agent-run'
import { fetchLinkedInSource } from './research/sources/linkedin'
import { fetchApolloSource }   from './research/sources/apollo'
import { fetchWebsiteSource }  from './research/sources/website'
import { fetchWebSearchSource } from './research/sources/web-search'
import { synthesizeResearch }  from './research/synthesize'
import { FrameRegistry } from '@/lib/style/sentence-frames'
import { FatalApiError, fatalApiReason } from '@/lib/agents/fatal-api-error'
import type {
  ProspectContext,
  RawSourceData,
  ResearchInput,
  ResearchResult,
  ResearchBatchInput,
  ResearchBatchSummary,
  ResearchBatchFailure,
  ResearchFrameCollision,
} from './research/types'

// ─── Supabase ─────────────────────────────────────────────────────────────────

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('prospect-research-agent-v2: missing Supabase env vars')
  return createClient(url, key)
}

// ─── Source tracking helpers ─────────────────────────────────────────────────

function buildSourceTracking(rawData: RawSourceData): {
  sources_attempted: string[]
  sources_successful: string[]
} {
  const attempted: string[] = []
  const successful: string[] = []

  for (const [name, result] of Object.entries(rawData) as [string, { available: boolean; error?: string }][]) {
    // 'not set' errors mean the source was intentionally skipped — don't count as attempted.
    const skipped = result.error?.includes('not set') || result.error?.includes('No LinkedIn URL')
    if (!skipped) attempted.push(name)
    if (result.available) successful.push(name)
  }

  return { sources_attempted: attempted, sources_successful: successful }
}

// ─── Storage ─────────────────────────────────────────────────────────────────

async function storeResearchResult(
  prospect: ProspectContext,
  rawData: RawSourceData,
  synthesis: Awaited<ReturnType<typeof synthesizeResearch>>,
  runId: string | null,
): Promise<string> {
  const supabase = getServiceClient()
  const { sources_attempted, sources_successful } = buildSourceTracking(rawData)

  const { data, error } = await supabase
    .from('prospect_research_results')
    .insert({
      prospect_id:          prospect.id,
      organisation_id:      prospect.organisation_id,
      run_id:               runId,
      icp_fit:              synthesis.icp_fit,
      has_dateable_signal:  synthesis.has_dateable_signal,
      signal_observation:   synthesis.signal_observation,
      signal_relevance:     synthesis.signal_relevance,
      qualification_status: synthesis.qualification_status,
      qualification_reason: synthesis.qualification_reason,
      // The audit row keeps the proxy when no trigger was written, so what the agent WOULD
      // have said stays inspectable. signal_relevance on this same row disambiguates:
      // no_signal means this column holds a proxy, not a researched observation.
      trigger_text:         synthesis.trigger_text ?? synthesis.icp_pain_proxy,
      trigger_source:       synthesis.trigger_source,
      synthesis_reasoning:  synthesis.reasoning,
      synthesis_confidence: synthesis.confidence,
      raw_linkedin:         rawData.linkedin.available ? rawData.linkedin : { error: rawData.linkedin.error },
      raw_apollo:           rawData.apollo.available   ? rawData.apollo   : { error: rawData.apollo.error },
      raw_website:          rawData.website.available  ? rawData.website  : { error: rawData.website.error },
      raw_web_search:       rawData.web_search.available ? rawData.web_search : { error: rawData.web_search.error },
      sources_attempted,
      sources_successful,
      relevance_reason: synthesis.relevance_reason,
      // Every candidate considered, winner included, with six-test scores and provenance.
      // Rejected candidates are kept deliberately so selection is auditable.
      candidates:            synthesis.candidates,
      selected_candidate_id: synthesis.selected_candidate_id,
    })
    .select('id')
    .single()

  if (error || !data) {
    throw new Error(`Failed to store research result: ${error?.message ?? 'no id returned'}`)
  }

  return data.id as string
}

async function updateProspect(
  prospect: ProspectContext,
  synthesis: Awaited<ReturnType<typeof synthesizeResearch>>,
  resultId: string,
): Promise<void> {
  const supabase = getServiceClient()

  const update: Record<string, unknown> = {
    icp_fit:                    synthesis.icp_fit,
    has_dateable_signal:        synthesis.has_dateable_signal,
    signal_observation:         synthesis.signal_observation,
    signal_relevance:           synthesis.signal_relevance,
    classified_at:              new Date().toISOString(),
    qualification_status:       synthesis.qualification_status,
    current_research_result_id: resultId,
    // Keep personalisation_trigger in sync: compose-sequence.ts reads it directly and
    // treats ANY non-null value as a researched observation. NULL when no candidate was
    // selected, so composition resolves source 'none' and ships the variant's own opener.
    personalisation_trigger:    synthesis.trigger_text,
    trigger_confidence:         synthesis.confidence,
    trigger_data:               synthesis,
    research_ran_at:            new Date().toISOString(),
  }

  // Auto-suppress on disqualification.
  if (synthesis.qualification_status === 'disqualified') {
    update.suppressed          = true
    update.suppressed_at       = new Date().toISOString()
    update.suppression_reason  = synthesis.qualification_reason ?? 'Auto-disqualified by research agent'
  }

  const { error } = await supabase
    .from('prospects')
    .update(update)
    .eq('id', prospect.id)
    .eq('organisation_id', prospect.organisation_id)

  if (error) {
    logger.error('prospect-research-v2: failed to update prospect', {
      prospect_id: prospect.id,
      error: error.message,
    })
  }
}

// ─── Main function ────────────────────────────────────────────────────────────

export async function runProspectResearchAgentV2({
  prospect_id,
  client_id,
  frameRegistry,
}: ResearchInput & { frameRegistry?: FrameRegistry }): Promise<ResearchResult> {
  const agentRun = await startAgentRun({ organisation_id: client_id, agent_name: 'prospect-research-v2' })

  try {
    // Load prospect.
    const supabase = getServiceClient()
    const { data: prospect, error: fetchError } = await supabase
      .from('prospects')
      .select('id, first_name, last_name, company_name, role, email, linkedin_url, website_url, organisation_id, segment_id')
      .eq('id', prospect_id)
      .eq('organisation_id', client_id)
      .single()

    if (fetchError || !prospect) {
      throw new Error(`Prospect not found: ${prospect_id} for client ${client_id}`)
    }

    // Part C: if segment_id is null (prospect created before backfill or outside the
    // sourcing path), stamp it with the org's primary segment now. This ensures every
    // prospect has a segment before research and compose run.
    let segmentId: string | null = prospect.segment_id ?? null
    if (!segmentId) {
      const { data: primarySeg } = await supabase
        .from('segments')
        .select('id')
        .eq('organisation_id', client_id)
        .eq('is_default', true)
        .single()
      segmentId = primarySeg?.id ?? null
      if (segmentId) {
        await supabase
          .from('prospects')
          .update({ segment_id: segmentId })
          .eq('id', prospect_id)
          .eq('organisation_id', client_id)
      }
    }

    const ctx: ProspectContext = {
      id:              prospect.id,
      organisation_id: prospect.organisation_id,
      segment_id:      segmentId,
      first_name:      prospect.first_name,
      last_name:       prospect.last_name,
      company_name:    prospect.company_name,
      role:            prospect.role,
      email:           prospect.email,
      linkedin_url:    prospect.linkedin_url,
      website_url:     prospect.website_url,
    }

    const fullName = [ctx.first_name, ctx.last_name].filter(Boolean).join(' ') || 'Unknown'
    logger.debug('prospect-research-v2: starting', { prospect_id, name: fullName })

    // Run all four sources in parallel — failures are isolated per source.
    const [linkedIn, apollo, website, webSearch] = await Promise.all([
      fetchLinkedInSource(ctx),
      fetchApolloSource(ctx),
      fetchWebsiteSource(ctx),
      fetchWebSearchSource(ctx),
    ])

    const rawData: RawSourceData = {
      linkedin:   linkedIn,
      apollo:     apollo,
      website:    website,
      web_search: webSearch,
    }

    const { sources_attempted, sources_successful } = buildSourceTracking(rawData)
    logger.debug('prospect-research-v2: sources complete', { sources_attempted, sources_successful })

    // Synthesize.
    const synthesis = await synthesizeResearch(ctx, rawData, client_id)

    // Cross-prospect sentence-frame check. A repeated frame is invisible to any per-prospect
    // check because each sentence is individually fine, so it can only be caught against the
    // rest of the batch. Detection is deterministic and free: no API call, no LLM.
    //
    // On a hit the batch logs it and reports it in the summary. It deliberately does NOT
    // auto-regenerate: that would cost another Sonnet call per collision and make the batch
    // non-reproducible. The real fix is upstream, in the prompt that was handing the model a
    // stock frame as a worked example.
    // Only real triggers participate. A null trigger has no sentence to compare, and the
    // proxy is not sent to anyone, so registering it would manufacture collisions between
    // prospects that all correctly received nothing.
    if (frameRegistry && synthesis.trigger_text) {
      const collisions = frameRegistry.register(prospect.id, synthesis.trigger_text)
      for (const collision of collisions) {
        logger.warn('prospect-research-v2: repeated sentence frame across batch', {
          prospect_id:            prospect.id,
          first_seen_prospect_id: collision.firstSeenId,
          frame:                  collision.frame,
          trigger_text:           synthesis.trigger_text,
        })
      }
    }

    // Store research result.
    const resultId = await storeResearchResult(ctx, rawData, synthesis, agentRun.run_id)

    // Update prospect row.
    await updateProspect(ctx, synthesis, resultId)

    const summaryLine =
      `${fullName} at ${ctx.company_name ?? 'unknown'}. ` +
      `ICP fit: ${synthesis.icp_fit}. Signal: ${synthesis.has_dateable_signal ? synthesis.signal_relevance : 'none'}. ` +
      `Qualification: ${synthesis.qualification_status}. Confidence: ${synthesis.confidence}. ` +
      `Sources succeeded: ${sources_successful.join(', ') || 'none'}.`

    await agentRun.complete(summaryLine)

    return {
      prospect_id,
      client_id,
      research_result_id:   resultId,
      icp_fit:              synthesis.icp_fit,
      has_dateable_signal:  synthesis.has_dateable_signal,
      signal_observation:   synthesis.signal_observation,
      signal_relevance:     synthesis.signal_relevance,
      qualification_status: synthesis.qualification_status,
      qualification_reason: synthesis.qualification_reason,
      trigger_text:        synthesis.trigger_text,
      trigger_source:      synthesis.trigger_source,
      relevance_reason:    synthesis.relevance_reason,
      synthesis_confidence: synthesis.confidence,
      synthesis_reasoning: synthesis.reasoning,
      sources_attempted,
      sources_successful,
      candidates:            synthesis.candidates,
      selected_candidate_id: synthesis.selected_candidate_id,
      trigger_readability:   synthesis.trigger_readability,
      demotion_reason:       synthesis.demotion_reason,
    }

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await agentRun.fail(`prospect-research-v2 failed: ${message}`)
    throw err
  }
}

// ─── Cost estimate ────────────────────────────────────────────────────────────

import {
  COST_ANTHROPIC_LOW,
  COST_ANTHROPIC_HIGH,
  COST_APIFY,
  BRAVE_FREE_MONTHLY,
  BRAVE_PAID_PER_CALL,
  HAIKU_PERSONALIZATION_USD,
} from './research/cost-constants'

function printCostEstimate(totalProspects: number): void {
  const hasApify = !!process.env.APIFY_API_KEY
  const hasBrave = !!process.env.BRAVE_SEARCH_API_KEY

  const apifyCost    = hasApify ? totalProspects * COST_APIFY : 0
  const braveCallsNeeded = hasBrave ? totalProspects * 2 : 0
  // Conservative: assume worst case, all calls are paid (can't query current month usage)
  const braveCost    = hasBrave ? braveCallsNeeded * BRAVE_PAID_PER_CALL : 0
  const anthropicLow  = totalProspects * COST_ANTHROPIC_LOW
  const anthropicHigh = totalProspects * COST_ANTHROPIC_HIGH
  const haikuCost     = totalProspects * HAIKU_PERSONALIZATION_USD

  const totalLow  = apifyCost + anthropicLow  + haikuCost
  const totalHigh = apifyCost + braveCost + anthropicHigh + haikuCost

  console.log('')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  Pre-batch cost estimate — ${totalProspects} prospects`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  Apify LinkedIn   : ${hasApify  ? `~$${apifyCost.toFixed(2)} (${totalProspects}×$${COST_APIFY})`   : '✗ APIFY_API_KEY not set (skipped)'}`)
  if (hasBrave) {
    console.log(`  Brave Search     : ~$0–$${braveCost.toFixed(2)} (${braveCallsNeeded} calls; free up to ${BRAVE_FREE_MONTHLY}/month)`)
    console.log(`                     Check dashboard: https://api.search.brave.com/app/subscriptions`)
  } else {
    console.log(`  Brave Search     : $0 (key not set — Anthropic native search only)`)
  }
  console.log(`  Anthropic Sonnet : ~$${anthropicLow.toFixed(2)}–$${anthropicHigh.toFixed(2)}`)
  console.log(`  Anthropic Haiku  : ~$${haikuCost.toFixed(2)} (personalisation)`)
  console.log(`  Apollo           : $0 (included in plan)`)
  console.log('  ─────────────────────────────────────────────────')
  console.log(`  Estimated total  : ~$${totalLow.toFixed(2)}–$${totalHigh.toFixed(2)}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('')
}

function promptConfirm(question: string): Promise<boolean> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, answer => {
      rl.close()
      resolve(answer.trim().toLowerCase() === 'y')
    })
  })
}

// ─── Batch function ───────────────────────────────────────────────────────────

export async function runProspectResearchAgentV2Batch({
  prospect_ids,
  client_id,
  skip_existing = true,
  confirm_before_run = true,
  concurrency = 5,
}: ResearchBatchInput): Promise<ResearchBatchSummary> {
  const failures: ResearchBatchFailure[] = []
  const frame_collisions: ResearchFrameCollision[] = []
  const summary: ResearchBatchSummary = {
    total:          prospect_ids.length,
    completed:      0,
    skipped:        0,
    failed:         0,
    failures,
    failed_log_path: null,
    frame_collisions,
  }

  // One registry per batch. Sentence-frame repetition only exists across prospects, so
  // the state has to live at batch scope. Single-threaded JS means the p-limit workers
  // below cannot interleave a register() call, so no locking is needed.
  const frameRegistry = new FrameRegistry()

  // Show cost estimate and require confirmation for batches of 10+ prospects.
  if (confirm_before_run && prospect_ids.length >= 10) {
    printCostEstimate(prospect_ids.length)
    const confirmed = await promptConfirm('  Continue? [y/N]: ')
    if (!confirmed) {
      logger.info('prospect-research-v2 batch: aborted by user at cost estimate prompt')
      return summary
    }
    console.log('')
  }

  let idsToProcess = prospect_ids

  if (skip_existing) {
    const supabase = getServiceClient()
    const { data: existing } = await supabase
      .from('prospects')
      .select('id, current_research_result_id')
      .in('id', prospect_ids)
      .eq('organisation_id', client_id)

    const alreadyResearched = new Set(
      (existing ?? [])
        .filter(p => p.current_research_result_id)
        .map(p => p.id)
    )

    idsToProcess = prospect_ids.filter(id => {
      if (alreadyResearched.has(id)) {
        summary.skipped++
        return false
      }
      return true
    })
  }

  // Rough cost constants — used for progress log estimate only.
  const costPerProspect =
    (process.env.APIFY_API_KEY ? COST_APIFY : 0) + // Apify LinkedIn
    0.020 +                                          // Anthropic Sonnet synthesis
    HAIKU_PERSONALIZATION_USD                        // Anthropic Haiku personalisation

  const batchStart = Date.now()
  const limit      = pLimit(concurrency)
  let processed    = 0

  // Set on the first fatal API failure. Every queued worker checks it before spending a
  // call, so a spent credit balance stops the batch instead of burning the remainder and
  // writing a proxy over good data on each one.
  let fatal: FatalApiError | null = null

  const tasks = idsToProcess.map(prospect_id =>
    limit(async () => {
      if (fatal) {
        summary.failed++
        failures.push({ prospect_id, error: `Skipped: run aborted after ${fatal.reason}` })
        return
      }
      try {
        await runProspectResearchAgentV2({ prospect_id, client_id, frameRegistry })
        summary.completed++
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        if (fatalApiReason(err)) {
          fatal = err instanceof FatalApiError
            ? err
            : new FatalApiError(fatalApiReason(err) as string, err)
          logger.error('prospect-research-v2 batch: FATAL, aborting remaining prospects', {
            prospect_id,
            reason: fatal.reason,
          })
        } else {
          logger.error('prospect-research-v2 batch: prospect failed', { prospect_id, error: errorMsg })
        }
        summary.failed++
        failures.push({ prospect_id, error: errorMsg })
      }

      processed++
      const elapsed = (Date.now() - batchStart) / 1000
      const avgSec  = elapsed / processed
      const remaining = idsToProcess.length - processed
      const etaMin  = remaining > 0 ? Math.ceil((remaining * avgSec) / 60) : 0
      const spent   = (processed * costPerProspect).toFixed(2)

      logger.info('prospect-research-v2 batch: progress', {
        progress: `${processed}/${idsToProcess.length}`,
        completed: summary.completed,
        failed: summary.failed,
        spent_usd: `$${spent}`,
        eta_min: etaMin,
      })
    })
  )

  await Promise.all(tasks)

  // Loudly, and after the failure log is written so the partial run stays diagnosable.
  // The caller must not be able to read this as a completed batch.
  if (fatal) {
    throw new FatalApiError(
      `${(fatal as FatalApiError).reason}. ${summary.completed} of ${summary.total} prospects completed before the abort`,
      fatal,
    )
  }

  // Roll the registry's collisions into the summary so the caller sees uniformity in the
  // copy without reading the logs. Empty means every trigger had its own sentence shape.
  for (const collision of frameRegistry.allCollisions()) {
    frame_collisions.push({
      prospect_id:            collision.repeatedById,
      first_seen_prospect_id: collision.firstSeenId,
      frame:                  collision.frame,
      trigger_text:           collision.repeatedText,
    })
  }

  if (frame_collisions.length > 0) {
    logger.warn('prospect-research-v2 batch: repeated sentence frames detected', {
      collision_count: frame_collisions.length,
      frames: [...new Set(frame_collisions.map(c => c.frame))],
    })
  }

  if (failures.length > 0) {
    const timestamp  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const logDir     = path.join(process.cwd(), 'logs')
    const logPath    = path.join(logDir, `failed-prospects-${timestamp}.json`)
    try {
      fs.mkdirSync(logDir, { recursive: true })
      fs.writeFileSync(logPath, JSON.stringify({ client_id, failed_at: new Date().toISOString(), failures }, null, 2))
      summary.failed_log_path = logPath
      logger.info('prospect-research-v2 batch: failed prospects logged', { path: logPath, count: failures.length })
    } catch (writeErr) {
      logger.error('prospect-research-v2 batch: could not write failure log', { error: String(writeErr) })
    }
  }

  return summary
}
