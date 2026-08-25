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
import { FrameRegistry, frameShingles, sentenceKey } from '@/lib/style/sentence-frames'
import { BatchUniquenessRegistry } from '@/lib/agents/research/batch-uniqueness'
import { findAbstractNouns, findFigurativeVerbs } from '@/lib/style/abstract-nouns'
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
  ResearchAbstractNounHit,
  ObservationCandidate,
  SynthesisOutput,
  IcpFit,
  QualificationStatus,
  SynthesisConfidence,
} from './research/types'

// ─── Supabase ─────────────────────────────────────────────────────────────────

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('prospect-research-agent-v2: missing Supabase env vars')
  return createClient(url, key)
}

// ─── Source tracking helpers ─────────────────────────────────────────────────

/**
 * The error a reuse run puts on all four source stubs in place of fetching them.
 *
 * Shared by the code that WRITES the stubs and the code that READS them, because the two
 * have to agree on the exact string and stating it twice is how they stop agreeing.
 */
export const SOURCE_SKIPPED_REUSE = 'skipped: stored findings reused'

// Exported for its test. Nothing outside this module should need it.
export function buildSourceTracking(rawData: RawSourceData): {
  sources_attempted: string[]
  sources_successful: string[]
} {
  const attempted: string[] = []
  const successful: string[] = []

  for (const [name, result] of Object.entries(rawData) as [string, { available: boolean; error?: string }][]) {
    // 'not set' errors mean the source was intentionally skipped — don't count as attempted.
    //
    // A reuse run is the same kind of skip and was NOT counted as one, so its rows recorded
    // all four sources attempted and none successful. That is byte-for-byte the shape of the
    // 2026-08-20 Apify incident, where the sources really were attempted and really did all
    // fail. A source-failure alarm reading this column could not have told the two apart,
    // and the reuse rows outnumber the real failures.
    const skipped =
      result.error?.includes('not set')
      || result.error?.includes('No LinkedIn URL')
      || result.error?.includes(SOURCE_SKIPPED_REUSE)
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
  /**
   * When the classification being written was actually reached. NULL means this run
   * produced it, so now is correct. A stored-findings run passes the source row's
   * timestamp: it carried that verdict forward rather than reaching one, and stamping it
   * with now would make an untouched classification look freshly confirmed on every rerun.
   */
  classifiedAt: string | null = null,
): Promise<void> {
  const supabase = getServiceClient()

  const update: Record<string, unknown> = {
    icp_fit:                    synthesis.icp_fit,
    has_dateable_signal:        synthesis.has_dateable_signal,
    signal_observation:         synthesis.signal_observation,
    classified_at:              classifiedAt ?? new Date().toISOString(),
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
/**
 * How old stored findings may be before a reuse run refuses them and fetches instead.
 * Research triggers reference things that were recently true, so reusing an observation
 * indefinitely would eventually put a stale fact in a live email. Falling outside the
 * window is not an error: it falls back to a normal fetching run, which is correct and
 * merely costs money.
 */
export const STORED_FINDINGS_MAX_AGE_DAYS = 30

/**
 * Hard ceiling on rows examined per prospect. Every reuse run INSERTs another result row,
 * so an unbounded scan grows with usage. Deliberately not smaller: a single degraded batch
 * can occupy the whole recent history, and picking the best row out of one is the entire
 * reason this function does not simply take the most recent.
 */
const STORED_FINDINGS_SCAN_LIMIT = 50

/**
 * A stored result plus the classification it reached. The classification is carried rather
 * than recomputed: a reuse run performs no new analysis, so it has no verdict of its own.
 */
interface StoredFindings {
  result_id:            string
  candidates:           ObservationCandidate[]
  had_linkedin:         boolean
  created_at:           string
  synthesized_at:       string | null
  icp_fit:              IcpFit | null
  qualification_status: QualificationStatus | null
  qualification_reason: string | null
  confidence:           SynthesisConfidence | null
  has_dateable_signal:  boolean | null
  signal_observation:   string | null
  relevance_reason:     string | null
}

// Loads the BEST research result already on file for a prospect. "Best" is deliberately
// not "most recent": on 2026-08-20 an empty Apify balance produced a full batch of rows
// where LinkedIn silently failed, and most-recent would select exactly those. Ordering by
// LinkedIn-present, then candidate count, then recency, picks the last run that actually
// saw everything. The age window and the row cap bound WHICH rows are considered; they do
// not change that ordering.
// Exported for its test. The previous test mirrored this ordering in a local copy, which
// by construction could not fail when the real function drifted away from it.
export async function loadStoredFindings(
  supabase: ReturnType<typeof getServiceClient>,
  prospect_id: string,
  client_id: string,
): Promise<StoredFindings | null> {
  const cutoff = new Date(
    Date.now() - STORED_FINDINGS_MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()

  const { data, error } = await supabase
    .from('prospect_research_results')
    // One string literal, deliberately. Supabase infers the row type from the select as a
    // literal type, and splitting this across concatenated strings collapses every column
    // to GenericStringError.
    .select('id, candidates, sources_successful, created_at, synthesized_at, icp_fit, qualification_status, qualification_reason, synthesis_confidence, has_dateable_signal, signal_observation, relevance_reason')
    .eq('prospect_id', prospect_id)
    .eq('organisation_id', client_id)
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(STORED_FINDINGS_SCAN_LIMIT)

  // A query fault and an empty history are different events and only one of them is
  // routine. Collapsing both into a bare null meant a transient database failure looked
  // exactly like "this prospect has never been researched": the run fell through to the
  // paid four-source path and nothing in the log said why. The fallback is the same and is
  // safe either way, so this changes what gets recorded, not what happens next.
  if (error) {
    logger.error('prospect-research-v2: stored-findings lookup failed, falling back to a fetching run', {
      prospect_id,
      client_id,
      error: error.message,
    })
    return null
  }

  if (!data || data.length === 0) return null

  const scored = data
    .map(row => ({
      result_id: row.id as string,
      candidates: (row.candidates ?? []) as ObservationCandidate[],
      had_linkedin: ((row.sources_successful ?? []) as string[]).includes('linkedin'),
      created_at: row.created_at as string,
      synthesized_at: (row.synthesized_at ?? null) as string | null,
      icp_fit: (row.icp_fit ?? null) as IcpFit | null,
      qualification_status: (row.qualification_status ?? null) as QualificationStatus | null,
      qualification_reason: (row.qualification_reason ?? null) as string | null,
      confidence: (row.synthesis_confidence ?? null) as SynthesisConfidence | null,
      has_dateable_signal: (row.has_dateable_signal ?? null) as boolean | null,
      signal_observation: (row.signal_observation ?? null) as string | null,
      relevance_reason: (row.relevance_reason ?? null) as string | null,
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
//
// THE CLASSIFICATION IS CARRIED FORWARD, NOT RESTATED. This function used to return flat
// placeholders ('moderate', 'qualified', 'medium'), and updateProspect writes whatever it
// returns straight back onto the prospect. That was harmless only while the reuse path was
// unreachable. Once use_stored_findings became the default, any rerun would have flattened
// a strong prospect to moderate and re-qualified a disqualified one, silently, with no
// analysis behind the change. A reuse run did no new analysis, so it has no verdict to
// offer: it reports the one the source row reached. Where the source row has no value the
// old placeholder still applies, so a row predating those columns degrades no worse than
// it did before.
async function synthesisFromStored(
  stored: StoredFindings,
  ctx: ProspectContext,
  client_id: string,
): Promise<SynthesisOutput> {
  logger.info('prospect-research-v2: reusing stored findings, no sources fetched', {
    prospect_id: ctx.id,
    source_result_id: stored.result_id,
    candidate_count: stored.candidates.length,
    had_linkedin: stored.had_linkedin,
    findings_from: stored.created_at,
    carried_icp_fit: stored.icp_fit,
    carried_qualification_status: stored.qualification_status,
  })

  return {
    icp_fit: stored.icp_fit ?? 'moderate',
    has_dateable_signal: stored.has_dateable_signal ?? stored.candidates.some(c => c.date !== null),
    signal_observation: stored.signal_observation ?? stored.candidates[0]?.observation ?? null,
    signal_relevance: 'no_signal',   // overwritten by the judge verdict downstream
    qualification_status: stored.qualification_status ?? 'qualified',
    qualification_reason: stored.qualification_reason,
    confidence: stored.confidence ?? 'medium',
    trigger_text: null,              // the writer produces this, not synthesis
    icp_pain_proxy: null,
    trigger_source: null,
    relevance_reason: stored.relevance_reason
      ?? `Findings reused from research result ${stored.result_id} (${stored.created_at}). No sources fetched.`,
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
  use_stored_findings = true,
  frameRegistry,
  uniqueness,
}: ResearchInput & {
  frameRegistry?: FrameRegistry
  uniqueness?: BatchUniquenessRegistry
}): Promise<ResearchResult> {
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
          { available: false, profile_data: null, recent_posts: null, formatted: null, error: SOURCE_SKIPPED_REUSE },
          { available: false, formatted: null, raw: null, error: SOURCE_SKIPPED_REUSE },
          { available: false, url: null, content: null, fetch_method: null, error: SOURCE_SKIPPED_REUSE },
          { available: false, person_search: null, company_search: null, combined: null, error: SOURCE_SKIPPED_REUSE },
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
      // Batch-scoped. Absent on a single-prospect run, where there is nothing to collide with.
      uniqueness,
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
    // The BRIDGE half is gated during the run by BatchUniquenessRegistry, so registering
    // the whole opening here would re-report frames the gate has already guaranteed are
    // unique and drown the half that is genuinely report-only.
    if (frameRegistry && opening.observation) {
      const collisions = frameRegistry.register(prospect.id, opening.observation)
      for (const collision of collisions) {
        logger.warn('prospect-research-v2: repeated sentence frame across batch', {
          prospect_id:            prospect.id,
          first_seen_prospect_id: collision.firstSeenId,
          frame:                  collision.frame,
          trigger_text:           opening.observation,
        })
      }
    }

    // Abstract-noun count on what shipped. REPORT ONLY: logged and rolled into the batch
    // summary, never acted on. See src/lib/style/abstract-nouns.ts for why it does not gate.
    if (opening.written_won && opening.opening) {
      const copy = `${opening.opening} ${opening.question ?? ''}`
      const nouns = findAbstractNouns(copy)
      const verbs = findFigurativeVerbs(copy)
      if (nouns.length > 0 || verbs.length > 0) {
        logger.info('prospect-research-v2: unfilmable language in shipped opening', {
          prospect_id: ctx.id,
          nouns: nouns.map(h => h.noun),
          verbs: verbs.map(h => h.verb),
          count: [...nouns, ...verbs].reduce((t, h) => t + h.count, 0),
        })
      }
    }

    // Store research result.
    const resultId = await storeResearchResult(ctx, rawData, synthesis, agentRun.run_id, opening)

    // Update prospect row.
    // On a reuse run the classification came from the source row, so its timestamp goes
    // with it. On a fetching run this is null and updateProspect stamps now.
    await updateProspect(
      ctx, synthesis, resultId, opening,
      stored ? (stored.synthesized_at ?? stored.created_at) : null,
    )

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
      bridge_text:         opening.written_won ? opening.bridge : null,
      question_text:       opening.written_won ? opening.question : null,
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

  // The Haiku personalisation line was REMOVED from this estimate on 2026-08-24.
  // Composition makes zero model calls: its only one was the bridge, and BRIDGE_ENABLED
  // has been false since 5047e24. Summing it here inflated every estimate and is where
  // the ~$0.05/prospect attributed to composition came from.
  const totalLow  = apifyCost + anthropicLow
  const totalHigh = apifyCost + braveCost + anthropicHigh

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
  use_stored_findings = true,
}: ResearchBatchInput): Promise<ResearchBatchSummary> {
  const failures: ResearchBatchFailure[] = []
  const frame_collisions: ResearchFrameCollision[] = []
  const bridge_frame_collisions: ResearchFrameCollision[] = []
  const question_collisions: ResearchFrameCollision[] = []
  const abstract_noun_hits: ResearchAbstractNounHit[] = []
  const summary: ResearchBatchSummary = {
    total:          prospect_ids.length,
    completed:      0,
    skipped:        0,
    failed:         0,
    failures,
    failed_log_path: null,
    frame_collisions,
    bridge_frame_collisions,
    question_collisions,
    distinct_questions: 0,
    abstract_noun_hits,
    abstract_noun_total: 0,
  }

  // What actually shipped, for the post-run verification below. Only winners: a prospect
  // that fell back to template contributes no bridge and no written question.
  const shipped: { prospect_id: string; bridge: string; question: string }[] = []

  // One registry per batch. Sentence-frame repetition only exists across prospects, so
  // the state has to live at batch scope. Single-threaded JS means the p-limit workers
  // below cannot interleave a register() call, so no locking is needed.
  const frameRegistry = new FrameRegistry()

  // Batch-scoped uniqueness for the bridge and the closing question. Unlike frameRegistry
  // this one GATES: a colliding bridge is refused and the writer retries. See
  // batch-uniqueness.ts for why the bridge is gated and the observation is not.
  const uniqueness = new BatchUniquenessRegistry()

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
  // Research makes FOUR Sonnet calls per prospect: synthesis, writer, floor judge, judge.
  // A retry re-runs the writer, so a retried prospect is five or six. The 0.020 figure is
  // the measured blended cost of that set, not of one call.
  //
  // No Haiku term: composition makes zero model calls while BRIDGE_ENABLED is false.
  const costPerProspect =
    (process.env.APIFY_API_KEY ? COST_APIFY : 0) + // Apify LinkedIn
    0.020                                          // Anthropic Sonnet, four calls

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
        const result = await runProspectResearchAgentV2({
          prospect_id, client_id, frameRegistry, uniqueness, use_stored_findings,
        })
        if (result.bridge_text && result.question_text) {
          shipped.push({
            prospect_id,
            bridge: result.bridge_text,
            question: result.question_text,
          })
        }
        if (result.trigger_text) {
          // The QUESTION is copy too, and counting the opening alone under-reported. The
          // first batch under this check scored 0 while Makesha's closing question carried
          // "a reliable flow of the right conversations". A report that misses a hit is
          // worse than no report, because it reads as evidence the rule held.
          const copy = `${result.trigger_text} ${result.question_text ?? ''}`
          // Nouns and verbs are two halves of one rule: say a thing you could point a
          // camera at. Reported together so a batch that fixes one and not the other is
          // visible as such rather than as a win.
          const abstract = [
            ...findAbstractNouns(copy).map(h => ({ word: h.noun, count: h.count })),
            ...findFigurativeVerbs(copy).map(h => ({ word: h.verb, count: h.count })),
          ]
          if (abstract.length > 0) {
            abstract_noun_hits.push({
              prospect_id,
              nouns: abstract.map(h => h.word),
              count: abstract.reduce((t, h) => t + h.count, 0),
              opening: `${result.trigger_text}\n\n${result.question_text ?? ''}`.trim(),
            })
          }
        }
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

  // POST-RUN VERIFICATION OF THE GATE, recomputed from what shipped rather than trusted
  // from the registry that enforced it. If the gate works these are both empty; a non-empty
  // array is a defect in the gate, not a warning about the copy. Recomputing independently
  // is the point: a gate that reports on itself cannot catch its own bug.
  const shippedBridgeFrames = new Map<string, string>()
  const shippedQuestions = new Map<string, string>()

  for (const s of shipped) {
    for (const frame of new Set(frameShingles(s.bridge))) {
      const firstSeen = shippedBridgeFrames.get(frame)
      if (firstSeen !== undefined && firstSeen !== s.prospect_id) {
        bridge_frame_collisions.push({
          prospect_id:            s.prospect_id,
          first_seen_prospect_id: firstSeen,
          frame,
          trigger_text:           s.bridge,
        })
      } else if (firstSeen === undefined) {
        shippedBridgeFrames.set(frame, s.prospect_id)
      }
    }

    const qKey = sentenceKey(s.question)
    if (!qKey) continue
    const firstSeenQ = shippedQuestions.get(qKey)
    if (firstSeenQ !== undefined && firstSeenQ !== s.prospect_id) {
      question_collisions.push({
        prospect_id:            s.prospect_id,
        first_seen_prospect_id: firstSeenQ,
        frame:                  qKey,
        trigger_text:           s.question,
      })
    } else if (firstSeenQ === undefined) {
      shippedQuestions.set(qKey, s.prospect_id)
    }
  }

  summary.distinct_questions = shippedQuestions.size
  summary.abstract_noun_total = abstract_noun_hits.reduce((t, h) => t + h.count, 0)

  // Report only. A non-zero total is worth reading and is never a failure.
  logger.info('prospect-research-v2 batch: abstract nouns in shipped copy', {
    prospects_with_hits: abstract_noun_hits.length,
    total:               summary.abstract_noun_total,
    nouns:               [...new Set(abstract_noun_hits.flatMap(h => h.nouns))],
  })

  if (bridge_frame_collisions.length > 0 || question_collisions.length > 0) {
    logger.error('prospect-research-v2 batch: uniqueness gate let a collision through', {
      bridge_collisions:   bridge_frame_collisions.length,
      question_collisions: question_collisions.length,
    })
  } else {
    logger.info('prospect-research-v2 batch: bridges and closing questions all distinct', {
      shipped:            shipped.length,
      distinct_questions: summary.distinct_questions,
      reserved_frames:    uniqueness.bridgeFrameCount,
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
