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
import {
  fetchApprovedMessagingDoc,
  composeEmail1WithOpening,
  getVariantEmail1Frame,
} from '@/lib/composition/compose-sequence'
import { assignVariantDeterministically } from '@/lib/composition/variant-assignment'
import { writeAndJudgeOpening, type OpeningResult } from './research/write-opening'
import type {
  ProspectContext,
  RawSourceData,
  ResearchInput,
  ResearchResult,
  ResearchBatchInput,
  ResearchBatchSummary,
  ResearchBatchFailure,
  ResearchFrameCollision,
  ObservationCandidate,
  SynthesisOutput,
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
  opening: OpeningResult,
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
      signal_relevance:     opening.written_won ? 'use_as_hook' : 'no_signal',
      qualification_status: synthesis.qualification_status,
      qualification_reason: synthesis.qualification_reason,
      // The audit row keeps the proxy when no trigger was written, so what the agent WOULD
      // have said stays inspectable. signal_relevance on this same row disambiguates:
      // no_signal means this column holds a proxy, not a researched observation.
      // THE OPENING THAT SHIPPED, or the proxy when the judge held it. Only a SEND
      // verdict yields an opening; see updateProspect for the prospects-side rule.
      trigger_text:         opening.opening ?? synthesis.icp_pain_proxy,
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
  opening: OpeningResult,
): Promise<void> {
  const supabase = getServiceClient()

  const update: Record<string, unknown> = {
    icp_fit:                    synthesis.icp_fit,
    has_dateable_signal:        synthesis.has_dateable_signal,
    signal_observation:         synthesis.signal_observation,
    classified_at:              new Date().toISOString(),
    qualification_status:       synthesis.qualification_status,
    current_research_result_id: resultId,
    // THE ONLY WRITE SITE FOR personalisation_trigger, and it fires ONLY on SEND.
    // opening.opening is non-null if and only if the judge returned SEND on its final
    // read. On HOLD this is NULL, composition resolves source 'none', and the variant's
    // authored opener ships, which is approved copy and a perfectly good outcome.
    personalisation_trigger:    opening.written_won ? opening.opening : null,
    // Set and cleared together with the trigger: a written question without its opening
    // would put a bespoke CTA under an approved opener neither was written for.
    personalisation_question:   opening.written_won ? opening.question : null,
    signal_relevance:           opening.written_won ? 'use_as_hook' : 'no_signal',
    trigger_confidence:         synthesis.confidence,
    // The judge audit trail, per prospect, for sampled review later. Stored in the
    // existing trigger_data jsonb rather than behind a migration: the requirement is per
    // prospect, this column already carries the whole synthesis payload, and the shape of
    // a verdict record may still move.
    trigger_data:               { ...synthesis, judge: opening },
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

// ─── Stored findings, the no-fetch path ──────────────────────────────────────
//
// Loads the BEST research result already on file for a prospect. "Best" is deliberately
// not "most recent": on 2026-08-20 an empty Apify balance produced a full batch of rows
// where LinkedIn silently failed, and most-recent would select exactly those. Ordering by
// LinkedIn-present, then candidate count, then recency, picks the last run that actually
// saw everything.
async function loadStoredFindings(
  supabase: ReturnType<typeof getServiceClient>,
  prospect_id: string,
  client_id: string,
): Promise<{ result_id: string; candidates: ObservationCandidate[]; had_linkedin: boolean; created_at: string } | null> {
  const { data, error } = await supabase
    .from('prospect_research_results')
    .select('id, candidates, sources_successful, created_at')
    .eq('prospect_id', prospect_id)
    .eq('organisation_id', client_id)
    .order('created_at', { ascending: false })

  if (error || !data || data.length === 0) return null

  const scored = data
    .map(row => ({
      result_id: row.id as string,
      candidates: (row.candidates ?? []) as ObservationCandidate[],
      had_linkedin: ((row.sources_successful ?? []) as string[]).includes('linkedin'),
      created_at: row.created_at as string,
    }))
    .filter(r => r.candidates.length > 0)

  if (scored.length === 0) return null

  scored.sort((a, b) =>
    (Number(b.had_linkedin) - Number(a.had_linkedin))
    || (b.candidates.length - a.candidates.length)
    || b.created_at.localeCompare(a.created_at),
  )
  return scored[0]
}

// Rebuilds a SynthesisOutput from stored candidates without calling the model. The six
// tests already ran when these candidates were generated, and their only remaining job is
// to RANK the material handed to the writer, so re-scoring them would change nothing.
// Fields the writer and judge never read are set to honest placeholders rather than
// invented values.
async function synthesisFromStored(
  stored: { result_id: string; candidates: ObservationCandidate[]; had_linkedin: boolean; created_at: string },
  ctx: ProspectContext,
  client_id: string,
): Promise<SynthesisOutput> {
  logger.info('prospect-research-v2: reusing stored findings, no sources fetched', {
    prospect_id: ctx.id,
    source_result_id: stored.result_id,
    candidate_count: stored.candidates.length,
    had_linkedin: stored.had_linkedin,
    findings_from: stored.created_at,
  })

  return {
    icp_fit: 'moderate',
    has_dateable_signal: stored.candidates.some(c => c.date !== null),
    signal_observation: stored.candidates[0]?.observation ?? null,
    signal_relevance: 'no_signal',   // overwritten by the judge verdict downstream
    qualification_status: 'qualified',
    qualification_reason: null,
    confidence: 'medium',
    trigger_text: null,              // the writer produces this, not synthesis
    icp_pain_proxy: null,
    trigger_source: null,
    relevance_reason: `Findings reused from research result ${stored.result_id} (${stored.created_at}). No sources fetched.`,
    reasoning: `Stored-findings run. Candidates carried over from ${stored.result_id}.`,
    candidates: stored.candidates,
    selected_candidate_id: null,
    trigger_readability: {
      hard_fail: false, penalty: 0, max_sentence_words: 0, hedges: [],
      nominalisation_density: 0, nominalisation_over_threshold: false, reasons: [],
    },
    demotion_reason: null,
  }
}

// ─── Main function ────────────────────────────────────────────────────────────

export async function runProspectResearchAgentV2({
  prospect_id,
  client_id,
  use_stored_findings = false,
  frameRegistry,
}: ResearchInput & { frameRegistry?: FrameRegistry }): Promise<ResearchResult> {
  const agentRun = await startAgentRun({ organisation_id: client_id, agent_name: 'prospect-research-v2' })

  try {
    // Load prospect.
    const supabase = getServiceClient()
    const { data: prospect, error: fetchError } = await supabase
      .from('prospects')
      .select('id, first_name, last_name, company_name, role, email, linkedin_url, website_url, organisation_id, segment_id, variant_id')
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

    // Stored-findings path: skip every source and every synthesis call, and reuse the
    // candidates already on file. Nothing here touches Apify, Apollo, Brave or the
    // prospect's website.
    const stored = use_stored_findings
      ? await loadStoredFindings(supabase, prospect_id, client_id)
      : null

    if (use_stored_findings && !stored) {
      logger.warn('prospect-research-v2: no usable stored findings, falling back to a fetching run', {
        prospect_id,
      })
    }

    // Run all four sources in parallel — failures are isolated per source.
    const [linkedIn, apollo, website, webSearch] = stored
      ? [
          { available: false, profile_data: null, recent_posts: null, formatted: null, error: 'skipped: stored findings reused' },
          { available: false, formatted: null, raw: null, error: 'skipped: stored findings reused' },
          { available: false, url: null, content: null, fetch_method: null, error: 'skipped: stored findings reused' },
          { available: false, person_search: null, company_search: null, combined: null, error: 'skipped: stored findings reused' },
        ] as const
      : await Promise.all([
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

    // Synthesize. The six tests now RANK the raw material; they no longer choose what
    // ships. The writer below decides that, and the judge decides whether it ships at all.
    const synthesis = stored
      ? await synthesisFromStored(stored, ctx, client_id)
      : await synthesizeResearch(ctx, rawData, client_id)

    // ── Write the opening FOR the email it lands in, then judge the finished artifact ──
    //
    // The variant matters because the opening has to lead into THAT variant's P3 and CTA.
    // Read the assigned variant when there is one, otherwise resolve it with the same
    // deterministic hash composition uses, so the writer targets the variant that will
    // actually ship. Nothing is written back here: assignment stays composition's job.
    const messaging = await fetchApprovedMessagingDoc(supabase, client_id, ctx.segment_id)
    const availableVariants = messaging.content.variants
      ? Object.keys(messaging.content.variants).sort()
      : ['A', 'B', 'C', 'D']
    const variantId = prospect.variant_id ?? assignVariantDeterministically(ctx.id, availableVariants)
    const frame = getVariantEmail1Frame(messaging.content, variantId)

    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error('prospect-research-v2: ANTHROPIC_API_KEY not set')

    const { data: org } = await supabase.from('organisations').select('name').eq('id', client_id).single()

    const opening = await writeAndJudgeOpening({
      apiKey,
      clientName: (org?.name as string | null) ?? 'the client',
      prospectFirstName: ctx.first_name,
      candidates: synthesis.candidates,
      p3: frame.p3,
      cta: frame.cta,
      // The version the written opening has to beat: the variant's own approved opener.
      templateOpening: frame.authoredOpening,
      // The judge must read the real artifact, so this calls the exact production path.
      // first_name resolved so the judge reads exactly what the prospect receives.
      // question omitted keeps the variant's approved CTA, which is how the template side
      // of the comparison stays a complete, genuinely sendable email.
      composeEmail1: (text: string, question?: string | null) =>
        composeEmail1WithOpening(messaging.content, variantId, text, question ?? null, ctx.first_name).body,
      prospectId: ctx.id,
    })

    logger.info('prospect-research-v2: judge verdict', {
      prospect_id: ctx.id,
      variant_id: variantId,
      written_won: opening.written_won,
      retry_used: opening.retry_used,
      // retries_used is the count, not the boolean. A second retry only exists for prospects
      // with strong material, so both are needed to tell whether the extra attempt was
      // available and whether it was what rescued the opening.
      retries_used: opening.retries_used,
      strong_material: opening.strong_material,
      reason: opening.judge_reasoning,
    })

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
    if (frameRegistry && opening.opening) {
      const collisions = frameRegistry.register(prospect.id, opening.opening)
      for (const collision of collisions) {
        logger.warn('prospect-research-v2: repeated sentence frame across batch', {
          prospect_id:            prospect.id,
          first_seen_prospect_id: collision.firstSeenId,
          frame:                  collision.frame,
          trigger_text:           opening.opening,
        })
      }
    }

    // Store research result.
    const resultId = await storeResearchResult(ctx, rawData, synthesis, agentRun.run_id, opening)

    // Update prospect row.
    await updateProspect(ctx, synthesis, resultId, opening)

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
      trigger_text:        opening.written_won ? opening.opening : null,
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
  use_stored_findings = false,
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
  if (use_stored_findings) {
    logger.info('prospect-research-v2 batch: stored-findings mode, no sources will be fetched', {
      prospect_count: prospect_ids.length,
    })
  }

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
        await runProspectResearchAgentV2({ prospect_id, client_id, frameRegistry, use_stored_findings })
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
