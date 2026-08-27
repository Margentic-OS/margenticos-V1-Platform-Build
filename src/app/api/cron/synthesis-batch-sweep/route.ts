// POST /api/cron/synthesis-batch-sweep
//
// Called by Supabase pg_cron every 5 minutes. Reconciles, polls, collects and submits
// research synthesis batches.
//
// Auth: Authorization: Bearer ${CRON_SECRET}. Service role, same as every other sweep: it
// acts as a system process and reads across organisations to find work.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY A CRON AND NOT A JOB TYPE
//
// Polling a batch is a FREE, IDEMPOTENT lookup. The queue's mechanism is ctx.paid(),
// which stamps spend the instant a paid call returns so a reclaimed job cannot pay twice,
// and there is nothing here for it to protect. Same argument verify-pending makes, and
// the same shape as verify-catch-all.
//
// The one thing this sweep does that costs money, submission, is protected by a ledger
// row written BEFORE the call instead, exactly as verification_calls protects a paid
// probe. See batch-sweep.ts.
//
// The EXPENSIVE half, phase 2's writer and judge calls, is a queue job. The sweep
// enqueues it and does not run it.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY 5 MINUTES
//
// Most batches finish inside an hour, and the whole point of the change is a discount
// bought with latency, so polling faster buys nothing. Five minutes is chosen for the
// SUBMIT side rather than the poll side: an entry written by phase 1 waits at most five
// minutes before it joins a batch, which keeps a client's prospects close together in
// time and therefore sharing one cached prefix. Polling is free and rides along.

import { NextRequest, NextResponse } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import * as Sentry from '@sentry/nextjs'
import { logger } from '@/lib/logger'
import { runSynthesisBatchSweep } from '@/lib/agents/research/batch-sweep'
import { isQueueEnabled } from '@/lib/queue/flags'

export const dynamic = 'force-dynamic'
// Every long route in this repo declares this. The operator verification route shipped
// without it and could not finish its own default batch.
export const maxDuration = 300

const MONITOR_SLUG = 'synthesis-batch-sweep'
const MONITOR_CONFIG = {
  schedule: { type: 'crontab' as const, value: '*/5 * * * *' },
  checkinMargin: 5,
  maxRuntime: 6,
  timezone: 'UTC',
}

/**
 * One value drives all three instruments: the cron_heartbeats row, the Sentry check-in
 * and the HTTP response. They cannot disagree.
 *
 * THE HEARTBEAT IS NOT OPTIONAL AND IT IS WRITTEN ON EVERY EXIT PATH. MON-002 derives
 * liveness from staleness in cron_heartbeats alone, so a sweep that writes no row is
 * INVISIBLE to monitoring: it could stop entirely and nothing would say so. That is how
 * the Instantly poller ran dead for four months, and how verify-pending shipped dark.
 *
 * It matters more here than for a free sweep. This one is the only thing that ever
 * collects a batch. If it stops, prospects sit with their sources bought and their
 * synthesis paid for, and the first symptom is a client asking where their emails are.
 */
async function writeHeartbeat(
  supabase: SupabaseClient,
  ok: boolean,
  detail: string,
): Promise<void> {
  const { error } = await supabase
    .from('cron_heartbeats')
    .insert({ job_name: MONITOR_SLUG, ok, detail: detail.slice(0, 900) })

  // A failed heartbeat must not turn a successful sweep into a failed one. The
  // consequence is that MON-021 sees staleness and alarms, which is correct: from the
  // outside, an unobservable run and a missing run are the same thing.
  if (error) {
    logger.error('synthesis-batch-sweep: heartbeat write failed', {
      error: error.message,
      consequence: 'MON-021 will read this sweep as stale until the next successful write.',
    })
  }
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }

  const checkInId = Sentry.captureCheckIn(
    { monitorSlug: MONITOR_SLUG, status: 'in_progress' },
    MONITOR_CONFIG,
  )

  const supabase: SupabaseClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const finish = async (ok: boolean, detail: string, body: Record<string, unknown>, status = 200) => {
    await writeHeartbeat(supabase, ok, detail)
    Sentry.captureCheckIn(
      { checkInId, monitorSlug: MONITOR_SLUG, status: ok ? 'ok' : 'error' },
      MONITOR_CONFIG,
    )
    await Sentry.flush(2000)
    return NextResponse.json({ ok, ...body }, { status })
  }

  try {
    // A MISSING KEY IS A FAILURE, NOT A QUIET NO-OP. Without it the sweep would find
    // pending entries, write a ledger row, and fail on the submit for every organisation
    // in turn. Failing before any of that leaves the work untouched. The same shape as
    // verify-catch-all's BOUNCER_API_KEY check, which is there because it happened.
    if (!process.env.ANTHROPIC_API_KEY) {
      const detail = 'ANTHROPIC_API_KEY is not set, so no batch can be submitted or collected.'
      logger.error('synthesis-batch-sweep: missing API key', { error: detail })
      return finish(false, detail, { error: detail }, 500)
    }

    // ── THE DRAIN VALVE, READ HERE AND NOWHERE ELSE IN THE SWEEP ─────────────
    //
    // queue_research_collect off means "stop collecting". It is deliberately NOT the
    // rollback: batches already submitted are already paid for, and refusing to collect
    // them throws that money away. The rollback is queue_research_sources off, which
    // stops new work entering while this keeps draining what is in flight.
    //
    // Checked before any work so an operator who does turn it off gets a clean, visible
    // idle rather than a half-run.
    const collectEnabled = await isQueueEnabled(supabase, 'research_collect')
    if (!collectEnabled) {
      const detail =
        'queue_research_collect is false, so the sweep is idle. NOTE: if batches are ' +
        'in flight, their synthesis is already paid for and is not being collected.'
      logger.warn('synthesis-batch-sweep: collection disabled by flag')
      return finish(true, detail, { detail: 'collection disabled', idle: true })
    }

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const run = await runSynthesisBatchSweep(supabase, anthropic)

    // Errors inside a sweep are per-batch and per-entry: one organisation's submission
    // failing must not mark the whole pass failed, because the collections that already
    // succeeded in the same pass are real work that happened.
    const ok = run.errors.length === 0

    // THE MEASUREMENT THIS WHOLE CHANGE TURNS ON. cache_read_input_tokens against
    // cache_creation_input_tokens is the only production evidence that prompt caching
    // survives batching, and the 1-hour TTL is provisional until it is read on real data.
    const cacheReadRate =
      run.cache_read_tokens + run.cache_creation_tokens + run.input_tokens > 0
        ? run.cache_read_tokens / (run.cache_read_tokens + run.cache_creation_tokens + run.input_tokens)
        : null

    logger.info('synthesis-batch-sweep: pass complete', { ...run, cache_read_rate: cacheReadRate })

    const detail =
      `submitted ${run.submitted_entries} in ${run.submitted_batches} batch(es), ` +
      `polled ${run.polled}, collected ${run.collected_entries}, ` +
      `entry failures ${run.errored_entries}, aged out ${run.expired_batches}, ` +
      `requeued ${run.requeued_entries}, reconciled ${run.reconciled_batches}` +
      (cacheReadRate !== null ? `, cache reads ${(cacheReadRate * 100).toFixed(1)}%` : '') +
      (run.errors.length ? `. Errors: ${run.errors.slice(0, 3).join(' | ')}` : '')

    return finish(ok, detail, {
      submitted_batches: run.submitted_batches,
      submitted_entries: run.submitted_entries,
      polled: run.polled,
      collected_entries: run.collected_entries,
      errored_entries: run.errored_entries,
      expired_batches: run.expired_batches,
      requeued_entries: run.requeued_entries,
      reconciled_batches: run.reconciled_batches,
      cache_read_tokens: run.cache_read_tokens,
      cache_creation_tokens: run.cache_creation_tokens,
      input_tokens: run.input_tokens,
      output_tokens: run.output_tokens,
      cache_read_rate: cacheReadRate,
      errors: run.errors,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('synthesis-batch-sweep: unexpected failure', { error: message })
    return finish(false, `Unexpected failure: ${message}`, { error: message }, 500)
  }
}
