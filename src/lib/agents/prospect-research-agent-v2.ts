// Prospect Research Agent v2
// Run with: npx tsx --env-file=.env.local src/lib/agents/prospect-research-agent-v2.ts
//
// Architecture: all four sources run in parallel → single synthesis step → store.
// Sources: LinkedIn (Apify), Apollo, company website, web search.
// Output: prospect_research_results row + updated prospects columns.
// Tiers: Tier 1 = specific observation found. Tier 3 = ICP pain framing.
// v1 agent (prospect-research-agent.ts) remains in place until v2 is dogfooded end-to-end.

import { createClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { startAgentRun } from '@/lib/agents/log-agent-run'
import { fetchLinkedInSource } from './research/sources/linkedin'
import { fetchApolloSource }   from './research/sources/apollo'
import { fetchWebsiteSource }  from './research/sources/website'
import { fetchWebSearchSource } from './research/sources/web-search'
import { synthesizeResearch }  from './research/synthesize'
import type {
  ProspectContext,
  RawSourceData,
  ResearchInput,
  ResearchResult,
  ResearchBatchInput,
  ResearchBatchSummary,
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
      research_tier:        synthesis.tier,
      qualification_status: synthesis.qualification_status,
      qualification_reason: synthesis.qualification_reason,
      trigger_text:         synthesis.trigger_text,
      trigger_source:       synthesis.trigger_source,
      synthesis_reasoning:  synthesis.reasoning,
      synthesis_confidence: synthesis.confidence,
      raw_linkedin:         rawData.linkedin.available ? rawData.linkedin : { error: rawData.linkedin.error },
      raw_apollo:           rawData.apollo.available   ? rawData.apollo   : { error: rawData.apollo.error },
      raw_website:          rawData.website.available  ? rawData.website  : { error: rawData.website.error },
      raw_web_search:       rawData.web_search.available ? rawData.web_search : { error: rawData.web_search.error },
      sources_attempted,
      sources_successful,
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
    research_tier:              synthesis.tier,
    qualification_status:       synthesis.qualification_status,
    current_research_result_id: resultId,
    // Keep v1 fields in sync so compose-sequence.ts still works during transition.
    personalisation_trigger:    synthesis.trigger_text,
    research_source:            synthesis.trigger_source?.type ?? 'pain_proxy',
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
}: ResearchInput): Promise<ResearchResult> {
  const agentRun = await startAgentRun({ client_id, agent_name: 'prospect-research-v2' })

  try {
    // Load prospect.
    const supabase = getServiceClient()
    const { data: prospect, error: fetchError } = await supabase
      .from('prospects')
      .select('id, first_name, last_name, company_name, role, email, linkedin_url, organisation_id')
      .eq('id', prospect_id)
      .eq('organisation_id', client_id)
      .single()

    if (fetchError || !prospect) {
      throw new Error(`Prospect not found: ${prospect_id} for client ${client_id}`)
    }

    const ctx: ProspectContext = {
      id:              prospect.id,
      organisation_id: prospect.organisation_id,
      first_name:      prospect.first_name,
      last_name:       prospect.last_name,
      company_name:    prospect.company_name,
      role:            prospect.role,
      email:           prospect.email,
      linkedin_url:    prospect.linkedin_url,
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

    // Store research result.
    const resultId = await storeResearchResult(ctx, rawData, synthesis, agentRun.run_id)

    // Update prospect row.
    await updateProspect(ctx, synthesis, resultId)

    const summaryLine =
      `${fullName} at ${ctx.company_name ?? 'unknown'}. ` +
      `Tier: ${synthesis.tier}. Qualification: ${synthesis.qualification_status}. ` +
      `Confidence: ${synthesis.confidence}. ` +
      `Sources succeeded: ${sources_successful.join(', ') || 'none'}.`

    await agentRun.complete(summaryLine)

    return {
      prospect_id,
      client_id,
      research_result_id:  resultId,
      tier:                synthesis.tier,
      qualification_status: synthesis.qualification_status,
      qualification_reason: synthesis.qualification_reason,
      trigger_text:        synthesis.trigger_text,
      trigger_source:      synthesis.trigger_source,
      synthesis_confidence: synthesis.confidence,
      synthesis_reasoning: synthesis.reasoning,
      sources_attempted,
      sources_successful,
    }

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await agentRun.fail(`prospect-research-v2 failed: ${message}`)
    throw err
  }
}

// ─── Batch function ───────────────────────────────────────────────────────────

export async function runProspectResearchAgentV2Batch({
  prospect_ids,
  client_id,
  skip_existing = true,
}: ResearchBatchInput): Promise<ResearchBatchSummary> {
  const summary: ResearchBatchSummary = {
    total:     prospect_ids.length,
    completed: 0,
    skipped:   0,
    failed:    0,
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

  for (let i = 0; i < idsToProcess.length; i++) {
    const prospect_id = idsToProcess[i]
    try {
      await runProspectResearchAgentV2({ prospect_id, client_id })
      summary.completed++
    } catch (err) {
      logger.error('prospect-research-v2 batch: prospect failed', {
        prospect_id,
        error: String(err),
      })
      summary.failed++
    }

    // 1.5s between calls to avoid simultaneous API bursts.
    if (i < idsToProcess.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1500))
    }
  }

  return summary
}
