// Prospect Research, PHASE 2: collect the batched synthesis, then write and judge.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT THIS IS
//
// The second half of a research run whose synthesis went through Anthropic's Batch API.
// Phase 1 (prospect-research-sources-agent.ts) fetched the four sources, snapshotted
// everything this file needs, and submitted the synthesis call. A sweep collected the
// result onto the entry row. This turns that result into a finished research row.
//
// It runs up to 24 hours after phase 1, in a different process, on a different job, with
// its own lease and its own agent_runs row.
//
// ═════════════════════════════════════════════════════════════════════════════
// IT RE-READS ALMOST NOTHING, AND THAT IS THE POINT
//
// Every value this file takes from the SNAPSHOT rather than from the current database is
// a value that can move during the wait, silently, changing the copy a prospect receives
// with nothing failing anywhere:
//
//   raw_sources      re-fetching would re-buy Apify, Apollo and Brave. The 141-credit shape.
//   messaging_content the writer's p3, cta and template opening. A revision mid-wait
//                    would scope the opening to different copy than phase 1 planned for.
//   variant_id       composition may assign one during the wait, which would retarget the
//                    opening into a different variant's email.
//   detected_signal  a pure function of the sources AND THE CLOCK. A LinkedIn post near
//                    the recency threshold flips 24 hours later.
//   client_context   the five strings the system prompt renders from. Strategy documents
//                    can be re-versioned; a rebuilt prompt would also miss the cache.
//   segment_id       as phase 1 resolved and stamped it.
//
// WHAT IT DOES RE-READ, DELIBERATELY:
//
//   the prospect row  names and company, because those reach the copy and the CURRENT
//                     value is the correct one. A prospect whose name was corrected
//                     during the wait should receive the corrected name.
//   suppression and   because 24 hours is long enough for a prospect to become
//   send eligibility  unmailable, and writer plus judge is three or more Anthropic calls
//                     spent on copy that can never be sent.

import { createClient } from '@supabase/supabase-js'
import type { Message } from '@anthropic-ai/sdk/resources/messages'
import { logger } from '@/lib/logger'
import { startAgentRun } from '@/lib/agents/log-agent-run'
import { loadProspectContext } from './research/prospect-context'
import {
  synthesisFromMessage,
  synthesisFallback,
  type ClientDocContext,
  type DetectedSignal,
} from './research/synthesize'
import { produceOpening, loadClientName, type MessagingContent } from './research/produce-opening'
import { storeResearchResult, updateProspect } from './prospect-research-agent-v2'
import { checkResearchEligibility } from '@/lib/sourcing/send-eligibility-policy'
import { findAbstractNouns, findFigurativeVerbs } from '@/lib/style/abstract-nouns'
import { ZERO_TOKEN_USAGE, type RawSourceData } from './research/types'
import type { OpeningResult } from './research/write-opening'

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('prospect-research-collect: missing Supabase env vars')
  return createClient(url, key)
}

export interface ResearchCollectInput {
  prospect_id: string
  client_id: string
}

export type ResearchCollectResult =
  | {
      outcome: 'stored'
      research_result_id: string
      entry_id: string
      qualification_status: string
      trigger_written: boolean
      /** Whether the snapshotted messaging document is still the active approved one. */
      doc_superseded: boolean
    }
  /**
   * The prospect became unmailable during the wait. The synthesis is already paid for so
   * it is still stored, but no writer or judge call was made.
   */
  | { outcome: 'stored_without_opening'; research_result_id: string; entry_id: string; reason: string }

/** The snapshot columns, read back exactly as phase 1 wrote them. */
interface EntryRow {
  id: string
  state: string
  raw_sources: RawSourceData
  detected_signal: DetectedSignal
  client_context: ClientDocContext
  client_name: string
  segment_id: string | null
  variant_id: string
  messaging_doc_id: string
  messaging_content: MessagingContent
  response_message: Message | null
  result_type: string | null
  error: string | null
  batch_id: string | null
}

/**
 * Collect one prospect's batched synthesis and finish its research run.
 *
 * Opens and closes its OWN agent_runs row, because reap-agent-runs marks anything still
 * 'running' after 600 seconds as failed and a single run spanning the batch wait would be
 * reaped mid-flight.
 */
export async function runProspectResearchCollect({
  prospect_id,
  client_id,
}: ResearchCollectInput): Promise<ResearchCollectResult> {
  const agentRun = await startAgentRun({
    organisation_id: client_id,
    agent_name: 'prospect-research-collect',
  })

  try {
    const supabase = getServiceClient()

    // ── The entry, which is the whole input to this phase ─────────────────────
    //
    // 'succeeded' means Anthropic returned a Message. 'errored' and 'expired' mean it did
    // not, and those are NOT BILLED by Anthropic, but the SOURCES on this row still were.
    // So both are collected: the run finishes with a synthesis fallback rather than
    // throwing away four paid-for source payloads.
    const { data: entryData, error: entryError } = await supabase
      .from('synthesis_batch_entries')
      .select('id, state, raw_sources, detected_signal, client_context, client_name, segment_id, variant_id, messaging_doc_id, messaging_content, response_message, result_type, error, batch_id')
      .eq('prospect_id', prospect_id)
      .eq('organisation_id', client_id)
      .in('state', ['succeeded', 'errored', 'expired'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (entryError) {
      throw new Error(`Could not read the synthesis entry for prospect ${prospect_id}: ${entryError.message}`)
    }
    if (!entryData) {
      // Not a silent no-op. A collect job exists only because something enqueued it, so
      // finding no collectable entry means the two disagree and that must be visible.
      throw new Error(
        `No collectable synthesis entry for prospect ${prospect_id}. A research_collect ` +
        'job was enqueued but no entry is in succeeded, errored or expired state.',
      )
    }

    const entry = entryData as unknown as EntryRow

    // Names and company come from the CURRENT row on purpose: they reach the copy and the
    // current value is the correct one. A prospect whose name was corrected during the
    // wait should receive the corrected name.
    //
    // segment_id is the exception and comes from the SNAPSHOT. It is the key the messaging
    // document and the ICP were resolved under in phase 1, so re-resolving it here could
    // point the doc-superseded comparison at a different segment's document than the one
    // actually snapshotted. This line existed as a comment claiming an override that the
    // code did not perform; the claim is now true.
    const { ctx: liveCtx } = await loadProspectContext(supabase, prospect_id, client_id)
    const ctx = { ...liveCtx, segment_id: entry.segment_id }

    // ── Rebuild the synthesis. THE SAME FUNCTION THE INLINE PATH CALLS. ───────
    //
    // synthesisFromMessage is pure: no clock, no database, no network. Given the Message,
    // the prospect, the snapshotted client context and the snapshotted recency signal, it
    // returns byte-for-byte what synthesizeResearch would have returned had the call been
    // made inline. That equivalence is structural, not a claim a test has to keep
    // re-checking: synthesizeResearch is DEFINED in terms of this function.
    const synthesis = entry.response_message
      ? synthesisFromMessage(entry.response_message, ctx, entry.client_context, entry.detected_signal)
      : synthesisFallback(
          ctx, entry.client_context, entry.detected_signal,
          `Batch entry ${entry.id} returned ${entry.result_type ?? entry.state}: ${entry.error ?? 'no message'}`,
        )

    if (!entry.response_message) {
      logger.warn('prospect-research-collect: no synthesis message, storing the fallback', {
        prospect_id, entry_id: entry.id, state: entry.state, result_type: entry.result_type,
      })
    }

    // ── Is this prospect still worth spending writer and judge calls on? ──────
    //
    // Twenty-four hours is long enough for a prospect to be suppressed, to bounce, or to
    // be resolved as a catch-all we will not mail. The writer plus floor plus judge is
    // three or more Anthropic calls, and spending them on copy that can never be sent is
    // pure waste. The same policy module the enqueue gate uses, so the two cannot drift.
    const { data: liveRow } = await supabase
      .from('prospects')
      .select('suppressed, independent_verified_at, independent_email_status, email_send_ineligible_reason, verification_provider, second_pass_status, second_pass_provider')
      .eq('id', prospect_id)
      .eq('organisation_id', client_id)
      .single()

    const suppressed = liveRow?.suppressed === true
    const eligibility = checkResearchEligibility({
      independent_verified_at:      (liveRow?.independent_verified_at as string | null) ?? null,
      independent_email_status:     (liveRow?.independent_email_status as string | null) ?? null,
      email_send_ineligible_reason: (liveRow?.email_send_ineligible_reason as string | null) ?? null,
      verification_provider:        (liveRow?.verification_provider as string | null) ?? null,
      second_pass_status:           (liveRow?.second_pass_status as string | null) ?? null,
      second_pass_provider:         (liveRow?.second_pass_provider as string | null) ?? null,
    })

    // Batch completion time, so synthesized_at records when synthesis HAPPENED rather
    // than when it was collected. loadStoredFindings hands this to updateProspect as
    // classifiedAt, so a wrong value here makes an untouched verdict look freshly reached.
    const synthesizedAt = await batchEndedAt(supabase, entry.batch_id)

    if (suppressed || !eligibility.eligible) {
      const reason = suppressed ? 'suppressed' : (eligibility.eligible ? 'unknown' : eligibility.reason)
      logger.info('prospect-research-collect: no longer mailable, skipping writer and judge', {
        prospect_id, entry_id: entry.id, reason,
      })

      // The synthesis is paid for either way, so it is still stored: the candidates stay
      // available to a later reuse run and the spend stays visible. What is skipped is
      // the three-plus Anthropic calls that would produce copy nobody can send.
      const noOpening = EMPTY_OPENING
      const resultId = await storeResearchResult(ctx, entry.raw_sources, synthesis, agentRun.run_id, noOpening, synthesizedAt)
      await updateProspect(ctx, synthesis, resultId, noOpening, synthesizedAt)
      await markEntryCollected(supabase, entry.id, false)

      await agentRun.complete(`Collected, no opening written: prospect is ${reason}.`)
      return { outcome: 'stored_without_opening', research_result_id: resultId, entry_id: entry.id, reason }
    }

    // ── Writer, floor and judge, against the SNAPSHOTTED document ─────────────
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error('prospect-research-collect: ANTHROPIC_API_KEY not set')

    const opening = await produceOpening({
      apiKey,
      // Snapshotted, so the writer is briefed with the name it was briefed with in phase 1.
      clientName: entry.client_name || await loadClientName(supabase, client_id),
      ctx,
      candidates: synthesis.candidates,
      // THE SNAPSHOT, not a fresh fetch. See the header.
      messagingContent: entry.messaging_content,
      variantId: entry.variant_id,
      // No batch-uniqueness registry: it is scoped to one in-process batch run and this
      // phase processes one prospect per job.
    })

    logger.info('prospect-research-collect: judge verdict', {
      prospect_id: ctx.id,
      entry_id: entry.id,
      variant_id: entry.variant_id,
      written_won: opening.written_won,
      retries_used: opening.retries_used,
      strong_material: opening.strong_material,
      reason: opening.judge_reasoning,
    })

    // Abstract-noun count on what shipped. REPORT ONLY, same as the inline path.
    if (opening.written_won && opening.opening) {
      const copy = `${opening.opening} ${opening.question ?? ''}`
      const nouns = findAbstractNouns(copy)
      const verbs = findFigurativeVerbs(copy)
      if (nouns.length > 0 || verbs.length > 0) {
        logger.info('prospect-research-collect: unfilmable language in shipped opening', {
          prospect_id: ctx.id,
          nouns: nouns.map(h => h.noun),
          verbs: verbs.map(h => h.verb),
          count: [...nouns, ...verbs].reduce((t, h) => t + h.count, 0),
        })
      }
    }

    // ── One complete row, written once, exactly as the inline path writes it ──
    const resultId = await storeResearchResult(
      ctx, entry.raw_sources, synthesis, agentRun.run_id, opening, synthesizedAt,
    )
    await updateProspect(ctx, synthesis, resultId, opening, synthesizedAt)

    // Reported, never acted on. The snapshot is used regardless: that decision is made,
    // not deferred. This column is how often the decision mattered, and MON-021 surfaces
    // the rate rather than any single case.
    const docSuperseded = await isDocSuperseded(supabase, client_id, ctx.segment_id, entry.messaging_doc_id)
    if (docSuperseded) {
      logger.warn('prospect-research-collect: messaging document was revised during the batch wait', {
        prospect_id: ctx.id,
        entry_id: entry.id,
        snapshot_doc_id: entry.messaging_doc_id,
        note: 'The opening was written against the SNAPSHOT, which is what phase 1 scoped it to.',
      })
    }
    await markEntryCollected(supabase, entry.id, docSuperseded)

    await agentRun.complete(
      `Collected: ${synthesis.qualification_status}, ` +
      `${opening.written_won ? 'trigger written' : 'no trigger'}` +
      `${docSuperseded ? ', messaging doc superseded during the wait' : ''}.`,
    )

    return {
      outcome: 'stored',
      research_result_id: resultId,
      entry_id: entry.id,
      qualification_status: synthesis.qualification_status,
      trigger_written: opening.written_won,
      doc_superseded: docSuperseded,
    }

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await agentRun.fail(`prospect-research-collect failed: ${message}`)
    throw err
  }
}

/**
 * What updateProspect and storeResearchResult receive when no opening was written.
 *
 * written_won false is the load-bearing field: it makes personalisation_trigger and
 * personalisation_question NULL and signal_relevance 'no_signal', so composition resolves
 * source 'none' and ships the variant's approved opener. That is a correct outcome, not a
 * degraded one.
 */
//
// TYPED, NOT CAST. This was `as unknown as Parameters<typeof storeResearchResult>[4]`,
// which is the shape CLAUDE.md now names as its own failure mode: a cast on an object
// literal switches off the check that would have caught a missing or misspelled field.
// If OpeningResult ever gains a field, `satisfies OpeningResult` makes that a compile
// error here; the cast would have silently produced an object missing it, and the first
// symptom would have been a column written as undefined.
const EMPTY_OPENING = {
  opening: null,
  question: null,
  subject: null,
  bridge: null,
  observation: null,
  written_won: false,
  retry_used: false,
  retries_used: 0,
  strong_material: false,
  judge_reasoning: 'Not written: the prospect was no longer mailable when the batch was collected.',
  usage: ZERO_TOKEN_USAGE,
  // FOUND BY THE `satisfies` ABOVE, not by a test. The cast this replaced omitted both,
  // and updateProspect writes `trigger_data: { ...synthesis, judge: opening }`, so every
  // skipped prospect would have stored a judge record with two undefined fields. Empty
  // arrays are the honest values: no comparison was run and no gate was reached, because
  // the writer never ran at all.
  comparisons: [],
  gate_failures: [],
} satisfies OpeningResult

/** When the batch finished, or null when that is unknown and now() should apply. */
async function batchEndedAt(
  supabase: ReturnType<typeof getServiceClient>,
  batchId: string | null,
): Promise<string | null> {
  if (!batchId) return null
  const { data } = await supabase
    .from('synthesis_batches').select('ended_at').eq('id', batchId).maybeSingle()
  return (data?.ended_at as string | null) ?? null
}

/**
 * Is the snapshotted messaging document still the active, approved one?
 *
 * Answers false when nothing is currently approved, which is the promote-but-not-yet-
 * approved window. That window is a reason the CONTENT is snapshotted rather than a doc
 * id: fetchApprovedMessagingDoc matches nothing and throws inside it, and reporting
 * "superseded" for a document that is merely awaiting approval would be misleading.
 */
async function isDocSuperseded(
  supabase: ReturnType<typeof getServiceClient>,
  client_id: string,
  segment_id: string | null,
  snapshotDocId: string,
): Promise<boolean> {
  // MIRRORS fetchApprovedMessagingDoc's resolution order, and it has to.
  //
  // Messaging documents are SEGMENT-SCOPED: fetchApprovedMessagingDoc tries the
  // segment's document first and only falls back to any approved one for the client.
  // A first version of this function ignored the segment entirely and compared against
  // "the newest approved messaging document for this organisation", which for a
  // multi-segment client would report superseded on every single collect, because
  // another segment's newer document would always win the comparison. The rate would
  // have looked alarming and meant nothing.
  const base = () => supabase
    .from('strategy_documents')
    .select('id')
    .eq('organisation_id', client_id)
    .eq('document_type', 'messaging')
    .eq('status', 'active')
    .eq('client_approval_status', 'approved')
    .order('created_at', { ascending: false })
    .limit(1)

  let currentId: string | null = null
  if (segment_id) {
    const { data } = await base().eq('segment_id', segment_id).maybeSingle()
    currentId = (data?.id as string | null) ?? null
  }
  if (!currentId) {
    const { data } = await base().maybeSingle()
    currentId = (data?.id as string | null) ?? null
  }

  // Nothing currently approved is the promote-but-not-yet-approved window, where the old
  // row is archived and the new one is pending. No newer document has been APPROVED, so
  // reporting "superseded" there would be misleading. It is also a window in which
  // fetchApprovedMessagingDoc throws outright, which is one reason the content is
  // snapshotted rather than pointed at.
  if (!currentId) return false
  return currentId !== snapshotDocId
}

async function markEntryCollected(
  supabase: ReturnType<typeof getServiceClient>,
  entryId: string,
  docSuperseded: boolean,
): Promise<void> {
  const { error } = await supabase
    .from('synthesis_batch_entries')
    .update({ state: 'collected', doc_superseded: docSuperseded, updated_at: new Date().toISOString() })
    .eq('id', entryId)

  if (error) {
    // NOT fatal, and deliberately not thrown. The research row is already written and the
    // prospect is already updated, so the work is done and correct. An unmarked entry is
    // recoverable (the collect job is idempotent from here, and the one-live-entry index
    // still holds the slot), whereas throwing now would fail a job whose expensive work
    // succeeded and invite a retry of it.
    logger.error('prospect-research-collect: research stored but the entry could not be marked collected', {
      entry_id: entryId,
      error: error.message,
    })
  }
}
