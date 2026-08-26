// Prospect Research, PHASE 1: sources and snapshot.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT THIS IS
//
// The first half of a research run when synthesis goes through Anthropic's Batch API.
// Batch pricing is 50% of standard for identical bytes to an identical model, and
// synthesis is about 78% of the Anthropic spend per prospect.
//
// The cost is time: a batch may take 24 hours. Nothing here can hold a lease that long
// (research's lease is 360 seconds; reap-agent-runs kills any agent_runs row still
// 'running' after 600), so the run splits and this half ends the moment the expensive
// work is snapshotted.
//
//   PHASE 1  this file. Fetch the four sources, snapshot everything phase 2 needs,
//            write a synthesis_batch_entries row in 'pending_submission'.
//   SUBMIT   a sweep gathers pending entries per organisation into one batch.
//   PHASE 2  prospect-research-collect-agent.ts.
//
// The single-job path in prospect-research-agent-v2.ts is untouched and still the
// rollback. Both call the same loadProspectContext, the same fetchAllSources and the
// same buildSynthesisRequest, so this is a different control flow over identical work,
// not a second implementation of it.
//
// ═════════════════════════════════════════════════════════════════════════════
// THIS FILE WRITES NOTHING TO prospect_research_results, DELIBERATELY
//
// storeResearchResult requires an `opening`, so there is no row shape meaning "synthesis
// done, opening pending". And loadStoredFindings filters reuse candidates on
// candidates.length > 0 and nothing else, so a synthesis-only row HAS candidates: an
// ordinary run for another prospect would select it as reuse material and inherit a
// synthesis with no judged opening. Silently.
//
// So the intermediate state lives on synthesis_batch_entries and the research row is
// written once, complete, by phase 2.

import { createClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { startAgentRun } from '@/lib/agents/log-agent-run'
import { loadProspectContext } from './research/prospect-context'
import { fetchAllSources } from './research/fetch-sources'
import { buildSynthesisRequest } from './research/synthesize'
import { buildSourceTracking, loadStoredFindings, runProspectResearchAgentV2 } from './prospect-research-agent-v2'
import { fetchApprovedMessagingDoc } from '@/lib/composition/compose-sequence'
import { assignVariantDeterministically } from '@/lib/composition/variant-assignment'

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('prospect-research-sources: missing Supabase env vars')
  return createClient(url, key)
}

/**
 * The cache TTL the BATCHED synthesis call asks for.
 *
 * '1h' rather than the 5-minute default because a batch can exceed five minutes
 * outright, and Anthropic's own guidance is to use the longer window for batches with
 * shared context. A 13-call probe measured 85% cache reads at 1h against 69% at 5m
 * in-batch.
 *
 * PROVISIONAL, and the reason it is a named constant rather than a literal. Anthropic
 * documents in-batch cache hits as best-effort at 30% to 98%. A 1-hour write costs 2x
 * base input against 1.25x for 5 minutes, so at the bottom of that range this is a LOSS.
 * The probe also used max_tokens 16 while production uses 16,000 and generates ~6,200
 * output tokens, so a real batch may spread further and read less. The measured
 * cache_read_input_tokens on the first live batch decides whether this stays.
 *
 * The LIVE path is untouched by this: cache_control is per-call-site, so
 * synthesizeResearch keeps the 5-minute default with no flag anywhere.
 */
export const BATCH_CACHE_TTL = '1h' as const

export interface ResearchSourcesInput {
  prospect_id: string
  client_id: string
  /**
   * Reuse research already on file instead of paying for sources. Default TRUE, matching
   * the inline agent, because re-fetching every source for a prospect that already has
   * usable findings is the expensive half of a run and must be a deliberate choice.
   */
  use_stored_findings?: boolean
}

export type ResearchSourcesResult =
  /** Sources fetched and snapshotted. An entry is waiting to be gathered into a batch. */
  | { outcome: 'queued_for_batch'; entry_id: string; sources_successful: string[] }
  /**
   * Stored findings existed, so no synthesis call is needed and no batch was created.
   * The whole run completed inline. See the note at the delegation below.
   */
  | { outcome: 'completed_from_stored'; research_result_id: string }

/**
 * Run phase 1 for one prospect.
 *
 * Opens and closes its OWN agent_runs row. Each phase must, because reap-agent-runs
 * marks anything still 'running' after 600 seconds as failed, and a single run spanning
 * the batch wait would be reaped mid-flight while the work was still perfectly alive.
 */
export async function runProspectResearchSources({
  prospect_id,
  client_id,
  use_stored_findings = true,
}: ResearchSourcesInput): Promise<ResearchSourcesResult> {
  const agentRun = await startAgentRun({
    organisation_id: client_id,
    agent_name: 'prospect-research-sources',
  })

  try {
    const supabase = getServiceClient()
    const { ctx, extras } = await loadProspectContext(supabase, prospect_id, client_id)

    // ── STORED FINDINGS NEVER GO THROUGH A BATCH ──────────────────────────────
    //
    // A reuse run makes ZERO synthesis calls: synthesisFromStored rebuilds the output
    // from candidates already on file. There is nothing to batch and nothing to save, so
    // batching one would buy a 24-hour wait for a discount on a call that never happens.
    //
    // It delegates to the PROVEN single-job agent rather than reimplementing the reuse
    // path here. That run is cheap and fits a lease comfortably: no sources, no
    // synthesis, only the writer and judge calls.
    //
    // The check happens HERE rather than being left to the agent because the agent falls
    // back to a full fetching run when it finds nothing, which would bypass the batch
    // entirely and quietly undo the saving this whole change exists for.
    if (use_stored_findings) {
      const stored = await loadStoredFindings(supabase, prospect_id, client_id)
      if (stored) {
        logger.info('prospect-research-sources: stored findings exist, running inline with no batch', {
          prospect_id,
          source_result_id: stored.result_id,
        })
        const result = await runProspectResearchAgentV2({
          prospect_id,
          client_id,
          use_stored_findings: true,
        })
        await agentRun.complete(
          `Stored findings reused, no batch needed. Qualification: ${result.qualification_status}.`,
        )
        return { outcome: 'completed_from_stored', research_result_id: result.research_result_id }
      }
      logger.warn('prospect-research-sources: no usable stored findings, fetching', { prospect_id })
    }

    // ── THE PAID CALL ─────────────────────────────────────────────────────────
    // Apify, Apollo (row first), the website fetch and two Brave searches. Everything
    // below this line is snapshotting what it produced.
    const rawData = await fetchAllSources(ctx, extras)
    const { sources_attempted, sources_successful } = buildSourceTracking(rawData)
    logger.debug('prospect-research-sources: sources complete', { sources_attempted, sources_successful })

    // Builds the request WITHOUT sending it, and hands back the two things that cannot be
    // recomputed on the far side of the wait: the recency signal, which takes the clock,
    // and the client document context, which can be re-versioned.
    const { clientCtx, detectedSignal } = await buildSynthesisRequest(
      ctx, rawData, client_id, { ttl: BATCH_CACHE_TTL },
    )

    // ── THE DOCUMENT SNAPSHOT ─────────────────────────────────────────────────
    //
    // THE ONE THAT WOULD HAVE SHIPPED WRONG COPY. The writer takes p3, cta and the
    // template opening from the approved messaging document, and composeEmail1WithOpening
    // builds the artifact the judge reads from the same document. Today a run finishes in
    // about three minutes so the document cannot move under it. Across a batch wait it
    // can, and nothing would fail: the email would simply be different.
    //
    // The CONTENT is snapshotted, not a doc id. promote_strategy_doc_version creates a
    // NEW row and only marks the old one archived, so content is immutable per row and an
    // id would have been sufficient for correctness. A copy is kept anyway because it
    // also survives the window between a promotion and its approval, during which
    // fetchApprovedMessagingDoc matches nothing and THROWS.
    //
    // doc_id and version ride along for reporting only. Phase 2 compares them against the
    // then-current document to set doc_superseded, and MON-021 surfaces how often that
    // happened. The snapshot is used either way: that decision is made, not deferred.
    const messaging = await fetchApprovedMessagingDoc(supabase, client_id, ctx.segment_id)
    const { data: docRow } = await supabase
      .from('strategy_documents')
      .select('version')
      .eq('id', messaging.doc_id)
      .single()

    const availableVariants = messaging.content.variants
      ? Object.keys(messaging.content.variants).sort()
      : ['A', 'B', 'C', 'D']
    // Snapshotted because composition may run for this prospect during the wait and write
    // a variant_id. Phase 2 would otherwise retarget, and the opening would be written
    // for one variant's P3 and CTA while landing in another's email.
    const variantId = extras.variant_id ?? assignVariantDeterministically(ctx.id, availableVariants)

    const { data: org } = await supabase
      .from('organisations').select('name').eq('id', client_id).single()

    const { data: entry, error: entryError } = await supabase
      .from('synthesis_batch_entries')
      .insert({
        organisation_id:       client_id,
        prospect_id:           ctx.id,
        state:                 'pending_submission',
        raw_sources:           rawData,
        detected_signal:       detectedSignal,
        client_context:        clientCtx,
        client_name:           (org?.name as string | null) ?? 'the client',
        segment_id:            ctx.segment_id,
        variant_id:            variantId,
        messaging_doc_id:      messaging.doc_id,
        messaging_doc_version: (docRow?.version as string | null) ?? 'unknown',
        messaging_content:     messaging.content,
        phase1_run_id:         agentRun.run_id === 'unknown' ? null : agentRun.run_id,
      })
      .select('id')
      .single()

    if (entryError || !entry) {
      // LOUD, and it has to be. The sources are already bought at this point. Losing the
      // snapshot means the next attempt re-buys them, which is the 141-credit shape.
      // A thrown error leaves the job failed and visible; a swallowed one leaves a
      // prospect that silently never gets researched and money already spent.
      throw new Error(
        `Sources were fetched and PAID FOR but the snapshot could not be written for ` +
        `prospect ${ctx.id}: ${entryError?.message ?? 'no id returned'}. ` +
        'The next attempt will re-buy Apify, Apollo and Brave for this prospect.',
      )
    }

    const entryId = entry.id as string

    logger.info('prospect-research-sources: snapshotted, awaiting batch submission', {
      prospect_id: ctx.id,
      entry_id: entryId,
      variant_id: variantId,
      messaging_doc_id: messaging.doc_id,
      sources_successful,
      web_search_count: rawData.web_search.search_count,
    })

    await agentRun.complete(
      `Sources fetched and snapshotted. Succeeded: ${sources_successful.join(', ') || 'none'}. ` +
      `Entry ${entryId} awaiting batch submission.`,
    )

    return { outcome: 'queued_for_batch', entry_id: entryId, sources_successful }

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await agentRun.fail(`prospect-research-sources failed: ${message}`)
    throw err
  }
}
