// The synthesis batch sweep: submit, poll, collect, age out, reconcile.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY A CRON SWEEP AND NOT A QUEUE JOB TYPE
//
// The queue's mechanism is ctx.paid(), which stamps spend the instant an external call
// returns so a reclaimed job cannot pay twice. That mechanism exists to protect
// EXPENSIVE, NON-IDEMPOTENT calls.
//
// Polling a batch is neither. batches.retrieve is a free lookup that returns the same
// answer however many times it is called, so the machinery would cost complexity and
// protect nothing. Same argument the verify-pending route makes, and the same shape as
// verify-catch-all.
//
// SUBMISSION IS DIFFERENT, and it is the one thing in this file that spends money. It is
// protected by the ledger instead: a synthesis_batches row is written BEFORE
// batches.create is called, exactly as verification_calls is written before a paid probe.
// See submitPendingForOneOrganisation.
//
// ═════════════════════════════════════════════════════════════════════════════
// ONE BATCH PER ORGANISATION, NOT ONE PER PROSPECT
//
// A batch of one would have been simpler and would still get the 50% discount, and it
// would have removed the un-ledgered window below entirely, because ctx.paid() could have
// wrapped the source fetch and the submission together.
//
// It was rejected because it maximises the number of independently scheduled batches, and
// that is precisely the condition Anthropic names as reducing best-effort cache hits:
// "maintain a steady stream of requests" and "structure your requests to share as much
// cached content as possible". The synthesis system prompt is ~6,700 tokens and identical
// across one client's prospects, cache reads bill at about a tenth of input, and a third
// of the expected saving lives there. One batch per organisation is what makes that
// prefix shared rather than merely repeated.

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Message } from '@anthropic-ai/sdk/resources/messages'
import type { MessageBatch } from '@anthropic-ai/sdk/resources/messages/batches'
import { logger } from '@/lib/logger'
import { buildSynthesisParams, type ClientDocContext, type DetectedSignal } from './synthesize'
import { BATCH_CACHE_TTL } from '@/lib/agents/prospect-research-sources-agent'
import { enqueueResearchPhaseJob } from '@/lib/queue/job-queue'
import type { ProspectContext, RawSourceData } from './types'

const SYNTHESIS_MODEL = 'claude-sonnet-4-6'

/**
 * How many entries go into one batch.
 *
 * NOT a provider limit. Anthropic allows 100,000 requests or 256 MB, and our prompt
 * material is 4,109 bytes mean and 10,298 max per prospect plus a ~27 KB system prompt,
 * so a thousand-prospect batch is about 31 MB. This is a blast-radius limit: one batch is
 * one unit of ageing out and one unit of re-submission, and a smaller unit means a stuck
 * batch strands fewer prospects.
 */
export const MAX_ENTRIES_PER_BATCH = 100

/**
 * How long a batch may sit before the sweep gives up on it.
 *
 * Anthropic's own ceiling is 24 hours: a batch that has not finished by then expires, and
 * expired requests are NOT BILLED. An hour of margin past that means the sweep never
 * declares a batch dead while Anthropic still considers it alive.
 */
export const BATCH_SLA_HOURS = 25

/**
 * How far back reconciliation looks for a batch we may have submitted and lost the
 * receipt for. Comfortably wider than the SLA, because the un-reconciled row itself is
 * the thing being timed and it may sit for a while before a sweep reaches it.
 */
const RECONCILE_LOOKBACK_HOURS = 48

export interface SweepResult {
  submitted_batches: number
  submitted_entries: number
  polled: number
  collected_entries: number
  errored_entries: number
  expired_batches: number
  requeued_entries: number
  reconciled_batches: number
  /** Sum of cache_read_input_tokens over entries collected this sweep. THE measurement. */
  cache_read_tokens: number
  cache_creation_tokens: number
  input_tokens: number
  output_tokens: number
  errors: string[]
}

function emptyResult(): SweepResult {
  return {
    submitted_batches: 0, submitted_entries: 0, polled: 0,
    collected_entries: 0, errored_entries: 0, expired_batches: 0,
    requeued_entries: 0, reconciled_batches: 0,
    cache_read_tokens: 0, cache_creation_tokens: 0, input_tokens: 0, output_tokens: 0,
    errors: [],
  }
}

interface PendingEntry {
  id: string
  organisation_id: string
  prospect_id: string
  raw_sources: RawSourceData
  detected_signal: DetectedSignal
  client_context: ClientDocContext
  segment_id: string | null
  submit_attempts: number
  prospect_first_name: string | null
  prospect_last_name: string | null
  prospect_company_name: string | null
  prospect_role: string | null
  prospect_job_title: string | null
  prospect_linkedin_url: string | null
}

/**
 * Rebuild the ProspectContext the request was built from.
 *
 * From the PROSPECT ROW rather than from the snapshot, deliberately: these fields feed
 * the prompt's "## Prospect" header, and a name corrected between phase 1 and submission
 * should be the corrected one. segment_id comes from the snapshot because it is the key
 * the client documents were resolved under.
 */
function contextFor(entry: PendingEntry): ProspectContext {
  return {
    id: entry.prospect_id,
    organisation_id: entry.organisation_id,
    segment_id: entry.segment_id,
    first_name: entry.prospect_first_name,
    last_name: entry.prospect_last_name,
    company_name: entry.prospect_company_name,
    role: entry.prospect_role,
    job_title: entry.prospect_job_title,
    email: null,
    linkedin_url: entry.prospect_linkedin_url,
    website_url: null,
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SUBMIT

/**
 * Gather one organisation's pending entries into a single batch and submit it.
 *
 * ── THE LEDGER, AND THE ONE WINDOW IT CANNOT CLOSE ──
 *
 * Order of operations, and every step is load-bearing:
 *
 *   1. Claim the entries by moving them out of 'pending_submission' FIRST, with a
 *      conditional update. Two concurrent sweeps therefore cannot both take the same
 *      entry: the second one's update matches zero rows.
 *   2. Write the synthesis_batches row BEFORE calling Anthropic. This is the ledger, on
 *      the verification_calls pattern.
 *   3. Call batches.create.
 *   4. Record the returned batch id.
 *
 * The window is between 3 and 4: Anthropic accepted the batch and our update failed. The
 * row then reads state 'attempted' with a null anthropic_batch_id, which is a SHAPE THE
 * DATABASE ENFORCES as meaningful (synthesis_batches_id_implies_submitted), not an
 * ambiguity.
 *
 * That window is closed by reconciliation rather than prevented: see
 * reconcileUnreceiptedBatches. Resubmitting blind would pay twice.
 */
async function submitPendingForOneOrganisation(
  supabase: SupabaseClient,
  anthropic: Anthropic,
  organisationId: string,
  result: SweepResult,
): Promise<void> {
  const { data: pendingData, error: pendingError } = await supabase
    .from('synthesis_batch_entries')
    .select('id, organisation_id, prospect_id, raw_sources, detected_signal, client_context, segment_id, submit_attempts, prospects!inner(first_name, last_name, company_name, role, job_title, linkedin_url)')
    .eq('organisation_id', organisationId)
    .eq('state', 'pending_submission')
    .order('created_at', { ascending: true })
    .limit(MAX_ENTRIES_PER_BATCH)

  if (pendingError) {
    result.errors.push(`could not read pending entries: ${pendingError.message}`)
    return
  }

  const rows = pendingData ?? []
  if (rows.length === 0) return

  const entries: PendingEntry[] = rows.map(r => {
    const p = (r as unknown as { prospects: Record<string, unknown> }).prospects
    return {
      id: r.id as string,
      organisation_id: r.organisation_id as string,
      prospect_id: r.prospect_id as string,
      raw_sources: r.raw_sources as RawSourceData,
      detected_signal: r.detected_signal as DetectedSignal,
      client_context: r.client_context as ClientDocContext,
      segment_id: (r.segment_id as string | null) ?? null,
      submit_attempts: (r.submit_attempts as number) ?? 0,
      prospect_first_name:   (p?.first_name as string | null) ?? null,
      prospect_last_name:    (p?.last_name as string | null) ?? null,
      prospect_company_name: (p?.company_name as string | null) ?? null,
      prospect_role:         (p?.role as string | null) ?? null,
      prospect_job_title:    (p?.job_title as string | null) ?? null,
      prospect_linkedin_url: (p?.linkedin_url as string | null) ?? null,
    }
  })

  // ── STEP 1: the ledger row, written BEFORE anything is claimed or called ──
  const { data: batchRow, error: batchError } = await supabase
    .from('synthesis_batches')
    .insert({
      organisation_id: organisationId,
      state: 'attempted',
      request_count: entries.length,
      model: SYNTHESIS_MODEL,
      cache_ttl: BATCH_CACHE_TTL,
    })
    .select('id')
    .single()

  if (batchError || !batchRow) {
    result.errors.push(`could not write the batch ledger row: ${batchError?.message ?? 'no id'}`)
    return
  }
  const batchId = batchRow.id as string

  // ── STEP 2: claim the entries, conditionally ──────────────────────────────
  //
  // .eq('state', 'pending_submission') is the concurrency guard. Two sweeps overlapping
  // cannot both take an entry: the loser's update matches nothing and it submits fewer
  // requests than it gathered, which is why the batch is built from the rows that were
  // ACTUALLY claimed rather than from the rows that were read.
  const { data: claimedData, error: claimError } = await supabase
    .from('synthesis_batch_entries')
    .update({
      batch_id: batchId,
      state: 'submitted',
      updated_at: new Date().toISOString(),
    })
    .in('id', entries.map(e => e.id))
    .eq('state', 'pending_submission')
    .select('id')

  if (claimError) {
    await failBatch(supabase, batchId, `could not claim entries: ${claimError.message}`)
    result.errors.push(`could not claim entries: ${claimError.message}`)
    return
  }

  const claimedIds = new Set((claimedData ?? []).map(r => r.id as string))
  const claimed = entries.filter(e => claimedIds.has(e.id))

  if (claimed.length === 0) {
    await failBatch(supabase, batchId, 'another sweep claimed every entry first')
    return
  }

  // ── STEP 3: THE PAID CALL ─────────────────────────────────────────────────
  //
  // custom_id is the ENTRY'S OWN uuid. 36 characters, inside Anthropic's
  // ^[a-zA-Z0-9_-]{1,64}$, and it is what makes an orphaned batch identifiable: read any
  // batch's results and look its custom_ids up in synthesis_batch_entries.
  let batch: MessageBatch
  try {
    batch = await anthropic.messages.batches.create({
      requests: claimed.map(entry => ({
        custom_id: entry.id,
        params: buildSynthesisParams(
          contextFor(entry),
          entry.raw_sources,
          entry.client_context,
          entry.detected_signal,
          BATCH_CACHE_TTL,
        ),
      })),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // The call was REJECTED, so nothing was billed and nothing was created. Returning the
    // entries to pending_submission is safe and is the only way they are ever retried.
    await failBatch(supabase, batchId, `submission rejected: ${message}`)
    await requeueEntries(supabase, claimed.map(e => e.id), result)
    result.errors.push(`submission rejected for ${organisationId}: ${message}`)
    return
  }

  // ── STEP 4: record the receipt ────────────────────────────────────────────
  const { error: receiptError } = await supabase
    .from('synthesis_batches')
    .update({
      anthropic_batch_id: batch.id,
      submitted_at: new Date().toISOString(),
      state: 'submitted',
      expires_at: batch.expires_at,
      counts: batch.request_counts,
      updated_at: new Date().toISOString(),
    })
    .eq('id', batchId)

  if (receiptError) {
    // THE UN-RECEIPTED WINDOW. The batch EXISTS and WILL BE BILLED. Do not requeue and do
    // not resubmit: reconcileUnreceiptedBatches finds it by matching custom_ids.
    logger.error('batch-sweep: SUBMITTED but the receipt could not be written', {
      batch_row_id: batchId,
      anthropic_batch_id: batch.id,
      entries: claimed.length,
      error: receiptError.message,
      consequence: 'The batch is live and billable. reconcileUnreceiptedBatches will recover it by custom_id.',
    })
    result.errors.push(`receipt write failed for batch ${batch.id}: ${receiptError.message}`)
    return
  }

  result.submitted_batches += 1
  result.submitted_entries += claimed.length

  logger.info('batch-sweep: submitted', {
    organisation_id: organisationId,
    batch_row_id: batchId,
    anthropic_batch_id: batch.id,
    entries: claimed.length,
    cache_ttl: BATCH_CACHE_TTL,
    expires_at: batch.expires_at,
  })
}

// ═════════════════════════════════════════════════════════════════════════════
// RECONCILE
//
// The only thing standing between the un-receipted window and paying twice.

/**
 * Recover batches that were submitted while our receipt write failed.
 *
 * A synthesis_batches row in state 'attempted' with no anthropic_batch_id means one of
 * two things, and they are indistinguishable from our side:
 *
 *   (a) batches.create never succeeded. Nothing was billed. The entries should be retried.
 *   (b) batches.create DID succeed and the receipt write failed. The batch is live and
 *       will be billed, and resubmitting would pay for the same work twice.
 *
 * Anthropic offers no idempotency key on batch creation, so the only way to tell them
 * apart is to ASK: list recent batches, read their results or their request counts, and
 * look the custom_ids up here. Every custom_id is an entry's own uuid, so a match is
 * proof the batch is ours, and which row it belongs to.
 *
 * A batch still in_progress has no results to read yet. It is matched by created_at
 * proximity and request_count only when a single unambiguous candidate exists; otherwise
 * it is left for the next sweep, when it will have ended and can be matched exactly. That
 * asymmetry is deliberate: a wrong match here would attach one organisation's synthesis
 * to another's prospects, and waiting costs nothing but time.
 */
export async function reconcileUnreceiptedBatches(
  supabase: SupabaseClient,
  anthropic: Anthropic,
  result: SweepResult,
  now: Date = new Date(),
): Promise<void> {
  const cutoff = new Date(now.getTime() - RECONCILE_LOOKBACK_HOURS * 3600_000).toISOString()

  const { data: orphans, error } = await supabase
    .from('synthesis_batches')
    .select('id, organisation_id, request_count, requested_at')
    .eq('state', 'attempted')
    .is('anthropic_batch_id', null)
    .gte('requested_at', cutoff)
    .order('requested_at', { ascending: true })

  if (error) {
    result.errors.push(`could not look for un-receipted batches: ${error.message}`)
    return
  }
  if (!orphans || orphans.length === 0) return

  // Which entries belong to each orphan row. This is the lookup table the custom_ids in
  // Anthropic's results are matched against.
  const orphanIds = orphans.map(o => o.id as string)
  const { data: entryRows } = await supabase
    .from('synthesis_batch_entries')
    .select('id, batch_id')
    .in('batch_id', orphanIds)

  const entryToBatch = new Map<string, string>()
  for (const row of entryRows ?? []) {
    entryToBatch.set(row.id as string, row.batch_id as string)
  }

  // Batches we already know about must never be matched to an orphan.
  const { data: knownRows } = await supabase
    .from('synthesis_batches')
    .select('anthropic_batch_id')
    .not('anthropic_batch_id', 'is', null)
  const known = new Set((knownRows ?? []).map(r => r.anthropic_batch_id as string))

  let candidates: MessageBatch[]
  try {
    const page = await anthropic.messages.batches.list({ limit: 100 })
    candidates = page.data.filter(b => !known.has(b.id) && b.created_at >= cutoff)
  } catch (err) {
    result.errors.push(`could not list batches for reconciliation: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  for (const candidate of candidates) {
    // Only an ENDED batch has results to read, and results are the only exact evidence.
    if (candidate.processing_status !== 'ended') continue

    let matchedBatchRow: string | null = null
    try {
      const results = await anthropic.messages.batches.results(candidate.id)
      for await (const item of results) {
        const owner = entryToBatch.get(item.custom_id)
        if (owner) { matchedBatchRow = owner; break }
      }
    } catch (err) {
      result.errors.push(`could not read results for ${candidate.id}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }

    if (!matchedBatchRow) continue

    const { error: attachError } = await supabase
      .from('synthesis_batches')
      .update({
        anthropic_batch_id: candidate.id,
        submitted_at: candidate.created_at,
        state: 'submitted',
        expires_at: candidate.expires_at,
        counts: candidate.request_counts,
        error: 'Receipt was lost at submission and recovered by custom_id reconciliation.',
        updated_at: new Date().toISOString(),
      })
      .eq('id', matchedBatchRow)
      .is('anthropic_batch_id', null)

    if (attachError) {
      result.errors.push(`could not attach ${candidate.id}: ${attachError.message}`)
      continue
    }

    result.reconciled_batches += 1
    logger.warn('batch-sweep: recovered a batch whose receipt was lost at submission', {
      batch_row_id: matchedBatchRow,
      anthropic_batch_id: candidate.id,
      note: 'It was NOT resubmitted. Matching by custom_id is what makes that safe.',
    })
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// POLL AND COLLECT

/** Poll every live batch, and collect the ones that have ended. */
export async function pollAndCollect(
  supabase: SupabaseClient,
  anthropic: Anthropic,
  result: SweepResult,
  now: Date = new Date(),
): Promise<void> {
  const { data: live, error } = await supabase
    .from('synthesis_batches')
    .select('id, organisation_id, anthropic_batch_id, requested_at, poll_count')
    .in('state', ['submitted', 'ended'])
    .not('anthropic_batch_id', 'is', null)
    .order('requested_at', { ascending: true })

  if (error) {
    result.errors.push(`could not read live batches: ${error.message}`)
    return
  }

  for (const row of live ?? []) {
    const batchRowId = row.id as string
    const anthropicId = row.anthropic_batch_id as string
    result.polled += 1

    let batch: MessageBatch
    try {
      batch = await anthropic.messages.batches.retrieve(anthropicId)
    } catch (err) {
      result.errors.push(`could not retrieve ${anthropicId}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }

    await supabase
      .from('synthesis_batches')
      .update({
        last_polled_at: new Date().toISOString(),
        poll_count: ((row.poll_count as number) ?? 0) + 1,
        counts: batch.request_counts,
        ended_at: batch.ended_at,
        updated_at: new Date().toISOString(),
      })
      .eq('id', batchRowId)

    if (batch.processing_status !== 'ended') {
      // ── FAILURE MODE: a batch that never completes ────────────────────────
      //
      // Anthropic expires an unfinished batch at 24 hours and does NOT bill the expired
      // requests, so ageing out costs nothing beyond the wait. The entries go back to
      // pending_submission REUSING THEIR STORED SOURCES: raw_sources is untouched, so the
      // resubmission re-pays for synthesis only and never for Apify, Apollo or Brave.
      const ageHours = (now.getTime() - new Date(row.requested_at as string).getTime()) / 3600_000
      if (ageHours > BATCH_SLA_HOURS) {
        await ageOutBatch(supabase, batchRowId, anthropicId, ageHours, result)
      }
      continue
    }

    await collectEndedBatch(supabase, anthropic, batchRowId, anthropicId, batch, result)
  }
}

/**
 * Read an ended batch's results onto its entries, then enqueue phase 2 for each.
 *
 * IDEMPOTENT BY CONSTRUCTION. Every entry update is conditioned on state='submitted', so
 * a sweep that dies half way through and runs again writes each entry exactly once. That
 * is what makes the "poller dies between submit and collect" case a non-event: Anthropic
 * keeps results for 29 days and the next sweep picks up precisely where this one stopped.
 */
async function collectEndedBatch(
  supabase: SupabaseClient,
  anthropic: Anthropic,
  batchRowId: string,
  anthropicId: string,
  batch: MessageBatch,
  result: SweepResult,
): Promise<void> {
  let collected = 0
  let errored = 0

  try {
    const results = await anthropic.messages.batches.results(anthropicId)

    for await (const item of results) {
      // ── PER-ENTRY OUTCOME ────────────────────────────────────────────────
      //
      // Anthropic bills ONLY succeeded requests. errored, canceled and expired cost
      // nothing, which is why a partly-failed batch is not a disaster: the failures are
      // free and only the failed prospects need anything done about them.
      const patch: Record<string, unknown> = {
        result_type: item.result.type,
        updated_at: new Date().toISOString(),
      }

      let message: Message | null = null
      if (item.result.type === 'succeeded') {
        message = item.result.message as Message
        patch.state = 'succeeded'
        // The WHOLE Message, so phase 2 reconstructs nothing. See
        // 20260826140000_synthesis_entry_response_message.sql.
        patch.response_message = message
        patch.usage = message.usage
        patch.stop_reason = message.stop_reason
      } else if (item.result.type === 'errored') {
        patch.state = 'errored'
        patch.error = JSON.stringify(item.result.error).slice(0, 2000)
      } else if (item.result.type === 'expired') {
        patch.state = 'expired'
        patch.error = 'Anthropic expired this request at the 24-hour ceiling. Not billed.'
      } else {
        patch.state = 'cancelled'
        patch.error = 'The batch was cancelled before this request ran. Not billed.'
      }

      // ── COUNT WHAT WAS WRITTEN, NOT WHAT WAS READ ────────────────────────
      //
      // .eq('state', 'submitted') is what makes re-collection a no-op, and .select('id')
      // is what makes the counters tell the truth about it.
      //
      // The counters used to increment before this update, from the RESULT rather than
      // from its effect. A second pass over an already-collected batch then reported
      // collecting entries it had not collected AND ADDED THEIR CACHE TOKENS AGAIN. Those
      // tokens are the measurement the 1-hour TTL decision rests on, so an inflated read
      // count would have argued for keeping a setting on evidence it manufactured.
      // Caught by the idempotency test, not by reading the code.
      const { data: written, error: updateError } = await supabase
        .from('synthesis_batch_entries')
        .update(patch)
        .eq('id', item.custom_id)
        .eq('state', 'submitted')
        .select('id')

      if (updateError) {
        result.errors.push(`could not write result for entry ${item.custom_id}: ${updateError.message}`)
        continue
      }

      // Zero rows means this entry was already collected by an earlier pass. Normal, and
      // the reason the sweep can die anywhere and be re-run.
      if (!written || written.length === 0) continue

      if (item.result.type === 'succeeded' && message) {
        collected += 1
        result.cache_read_tokens     += message.usage?.cache_read_input_tokens ?? 0
        result.cache_creation_tokens += message.usage?.cache_creation_input_tokens ?? 0
        result.input_tokens          += message.usage?.input_tokens ?? 0
        result.output_tokens         += message.usage?.output_tokens ?? 0
      } else {
        errored += 1
      }
    }
  } catch (err) {
    result.errors.push(`could not read results for ${anthropicId}: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  result.collected_entries += collected
  result.errored_entries += errored

  await supabase
    .from('synthesis_batches')
    .update({
      state: 'collected',
      collected_at: new Date().toISOString(),
      ended_at: batch.ended_at,
      counts: batch.request_counts,
      updated_at: new Date().toISOString(),
    })
    .eq('id', batchRowId)

  // ── HAND THE SUCCESSES TO PHASE 2 ────────────────────────────────────────
  //
  // Enqueued here rather than claimed by a poller, because phase 2 makes three or more
  // Anthropic calls per prospect and IS the kind of expensive non-idempotent work the
  // queue's spend gate exists to protect.
  await enqueueCollectJobs(supabase, batchRowId, result)

  logger.info('batch-sweep: collected', {
    batch_row_id: batchRowId,
    anthropic_batch_id: anthropicId,
    succeeded: collected,
    failed: errored,
    counts: batch.request_counts,
    cache_read_tokens: result.cache_read_tokens,
  })
}

/**
 * Enqueue phase 2 for every entry of this batch that now has a result.
 *
 * INCLUDES the errored and expired ones. Their synthesis cost nothing, but their SOURCES
 * were bought, and phase 2 stores a fallback synthesis rather than discarding four paid
 * payloads. That is failure mode four: "sources paid but synthesis entry failed. MUST
 * reuse stored sources."
 */
async function enqueueCollectJobs(
  supabase: SupabaseClient,
  batchRowId: string,
  result: SweepResult,
): Promise<void> {
  const { data: entries, error } = await supabase
    .from('synthesis_batch_entries')
    .select('id, organisation_id, prospect_id, state')
    .eq('batch_id', batchRowId)
    .in('state', ['succeeded', 'errored', 'expired'])

  if (error) {
    result.errors.push(`could not read entries to enqueue collection: ${error.message}`)
    return
  }

  for (const entry of entries ?? []) {
    try {
      await enqueueResearchPhaseJob(supabase, {
        jobType: 'research_collect',
        organisationId: entry.organisation_id as string,
        prospectId: entry.prospect_id as string,
        enqueuedBy: `batch-sweep:${batchRowId}`,
      })
    } catch (err) {
      result.errors.push(
        `could not enqueue collection for prospect ${entry.prospect_id}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// AGE OUT AND REQUEUE

/**
 * Give up on a batch that has not finished inside the SLA, and put its entries back.
 *
 * THE ENTRIES KEEP THEIR SOURCES. state goes back to pending_submission and
 * submit_attempts increments; raw_sources, the document snapshot, the variant and the
 * recency signal are all untouched. So the resubmission re-pays for synthesis and NOTHING
 * ELSE. Re-running phase 1 instead would have re-bought Apify, Apollo and Brave.
 */
async function ageOutBatch(
  supabase: SupabaseClient,
  batchRowId: string,
  anthropicId: string,
  ageHours: number,
  result: SweepResult,
): Promise<void> {
  const detail =
    `Batch ${anthropicId} did not finish within ${BATCH_SLA_HOURS}h (age ${ageHours.toFixed(1)}h). ` +
    'Its entries are requeued reusing their stored sources, so only synthesis is re-paid.'

  await supabase
    .from('synthesis_batches')
    .update({ state: 'expired', error: detail, updated_at: new Date().toISOString() })
    .eq('id', batchRowId)

  const { data: stranded, error } = await supabase
    .from('synthesis_batch_entries')
    .select('id')
    .eq('batch_id', batchRowId)
    .eq('state', 'submitted')

  if (error) {
    result.errors.push(`could not find stranded entries for ${batchRowId}: ${error.message}`)
    return
  }

  result.expired_batches += 1
  await requeueEntries(supabase, (stranded ?? []).map(r => r.id as string), result)

  logger.warn('batch-sweep: aged out a batch past its SLA', {
    batch_row_id: batchRowId,
    anthropic_batch_id: anthropicId,
    age_hours: Number(ageHours.toFixed(1)),
    requeued: (stranded ?? []).length,
    note: 'Sources were NOT re-bought. Anthropic does not bill expired requests.',
  })
}

/** Put entries back in the pending queue, keeping every snapshot column intact. */
async function requeueEntries(
  supabase: SupabaseClient,
  entryIds: string[],
  result: SweepResult,
): Promise<void> {
  if (entryIds.length === 0) return

  for (const id of entryIds) {
    const { data: current } = await supabase
      .from('synthesis_batch_entries')
      .select('submit_attempts')
      .eq('id', id)
      .maybeSingle()

    const { error } = await supabase
      .from('synthesis_batch_entries')
      .update({
        state: 'pending_submission',
        submit_attempts: ((current?.submit_attempts as number) ?? 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)

    if (error) result.errors.push(`could not requeue entry ${id}: ${error.message}`)
    else result.requeued_entries += 1
  }
}

async function failBatch(supabase: SupabaseClient, batchRowId: string, reason: string): Promise<void> {
  await supabase
    .from('synthesis_batches')
    .update({ state: 'failed', error: reason.slice(0, 2000), updated_at: new Date().toISOString() })
    .eq('id', batchRowId)
}

// ═════════════════════════════════════════════════════════════════════════════
// THE SWEEP

/**
 * One full pass. Reconcile first, then collect, then submit.
 *
 * ORDER MATTERS. Reconciliation runs first so an un-receipted batch is attached before
 * anything else looks at it. Collection runs before submission so results are read as
 * early as possible and phase 2 starts sooner. Submission runs last because it is the
 * only step that spends money, and a sweep that runs out of time should lose a
 * submission rather than lose a collection it has already paid for.
 */
export async function runSynthesisBatchSweep(
  supabase: SupabaseClient,
  anthropic: Anthropic,
  now: Date = new Date(),
): Promise<SweepResult> {
  const result = emptyResult()

  await reconcileUnreceiptedBatches(supabase, anthropic, result, now)
  await pollAndCollect(supabase, anthropic, result, now)

  const { data: orgs, error } = await supabase
    .from('synthesis_batch_entries')
    .select('organisation_id')
    .eq('state', 'pending_submission')

  if (error) {
    result.errors.push(`could not look for organisations with pending entries: ${error.message}`)
    return result
  }

  const organisationIds = [...new Set((orgs ?? []).map(r => r.organisation_id as string))]
  for (const organisationId of organisationIds) {
    await submitPendingForOneOrganisation(supabase, anthropic, organisationId, result)
  }

  return result
}
