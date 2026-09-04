// POST /api/cron/verify-catch-all
//
// Called by Supabase pg_cron every 30 minutes. Runs the PAID second-pass verifier over
// prospects whose first-pass verdict could not confirm the mailbox, one organisation per
// invocation, oldest backlog first.
//
// Auth: Authorization: Bearer ${CRON_SECRET}. Service role, same as every other sweep: it
// acts as a system process and reads across organisations to find work.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY 30 MINUTES AND NOT 10
//
// The first-pass sweep runs every 10 minutes because it is free and its backlog is the whole
// prospect list. This one spends money and its backlog is, by construction, a small
// minority: only addresses the first pass could not confirm. The live backlog is 11
// addresses. A 30-minute cadence drains that in one firing and then idles, and idling
// cheaply matters more here than latency.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY A CRON AND NOT A QUEUE JOB, EVEN THOUGH THIS ONE COSTS MONEY
//
// The verify-pending route argues that verification does not need the queue because it is an
// idempotent lookup against a free tier with no spend to stamp, and adds: "If verification
// ever becomes paid per address, revisit this. The trigger for that is a price on the call."
//
// That trigger has now fired, and the answer is still no, for a different reason. The
// queue's mechanism is ctx.paid(), which stamps spend the instant an external call returns so
// a RECLAIMED job cannot pay twice. verification_calls does the same job more directly for
// this case: a row is written BEFORE the call, so an interrupted run leaves evidence of the
// spend whether or not it returned, and the budget check reads that ledger.
//
// The queue would additionally buy retry orchestration and concurrency, neither of which
// applies: a failed probe here should NOT be retried aggressively, because each retry bills,
// and the whole backlog fits in one batch. Revisit if the backlog ever outgrows a single
// invocation.

import { NextRequest, NextResponse } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import * as Sentry from '@sentry/nextjs'
import { logger } from '@/lib/logger'
import {
  runSecondPassBatch,
  DEFAULT_SECOND_PASS_BATCH_SIZE,
} from '@/lib/sourcing/second-pass-trigger'
import { SECOND_PASS_WORTH_PAYING_FOR } from '@/lib/sourcing/verification-verdict'
import { excludeTierRejected } from '@/lib/sourcing/tier-verdict'

export const dynamic = 'force-dynamic'
// Every long route in this repo declares this. The operator verification route shipped
// without it and could not finish its own default batch.
export const maxDuration = 300

const MONITOR_SLUG = 'verify-catch-all'
const MONITOR_CONFIG = {
  schedule: { type: 'crontab' as const, value: '*/30 * * * *' },
  checkinMargin: 10,
  maxRuntime: 6,
  timezone: 'UTC',
}

/**
 * One value drives all three instruments: the cron_heartbeats row, the Sentry check-in and
 * the HTTP response. They cannot disagree.
 *
 * THE HEARTBEAT IS NOT OPTIONAL. MON-002's shape derives liveness from staleness in
 * cron_heartbeats alone, so a sweep that writes no row is invisible to monitoring: it could
 * stop entirely and nothing would say so. That is how the Instantly poller ran dead for four
 * months, and how verify-pending shipped dark hours before this route was written.
 */
async function writeHeartbeat(
  supabase: SupabaseClient,
  ok: boolean,
  detail: string,
): Promise<void> {
  const { error } = await supabase
    .from('cron_heartbeats')
    .insert({ job_name: MONITOR_SLUG, ok, detail: detail.slice(0, 900) })

  // A failed heartbeat must not turn a successful sweep into a failed one. The consequence
  // is that MON-020 sees staleness and alarms, which is correct: from the outside, an
  // unobservable run and a missing run are the same thing.
  if (error) {
    logger.error('verify-catch-all: heartbeat write failed', {
      error: error.message,
      consequence: 'MON-020 will read this sweep as stale until the next successful write.',
    })
  }
}

/**
 * ONE ORGANISATION PER INVOCATION, oldest-waiting first.
 *
 * ARCHIVED ORGANISATIONS ARE EXCLUDED. Without this join, prospects in the archived
 * "DRY RUN TEST" organisation would be the oldest pending work on the platform and every
 * sweep would pick them first, spending REAL MONEY on a dead test organisation while
 * reporting itself busy and real work waited. That exact bug was found and fixed on the
 * first-pass sweep hours before this route existed; there it wasted a free tier, here it
 * would waste cash.
 */
async function findOrganisationWithSecondPassBacklog(
  supabase: SupabaseClient,
): Promise<string | null> {
  const { data, error } = await excludeTierRejected(supabase
    .from('prospects')
    .select('organisation_id, created_at, organisations!inner(archived_at)')
    .eq('suppressed', false)
    .not('email', 'is', null)
    .in('independent_email_status', SECOND_PASS_WORTH_PAYING_FOR as string[])
    .is('second_pass_status', null))
    // THE TIER GATE, AND HERE IT GUARDS CASH RATHER THAN A FREE TIER.
    //
    // Measured 2026-09-03 against verification_calls: 6 of the 52 paid second-pass calls
    // ever made were spent on prospects tiering had already rejected. Five came back
    // deliverable, which is the worst outcome available: an address confirmed, at cost, for
    // a prospect that will never be emailed.
    //
    // This must match the row selector in second-pass-trigger.ts exactly. Gating only one of
    // the two turns a money bug into a starvation bug, which is what happened on the
    // first-pass sweep and is documented on its picker.
    //
    // excludeTierRejected, not requireTierPresent: see src/lib/sourcing/tier-verdict.ts.
    .is('organisations.archived_at', null)
    .order('created_at', { ascending: true })
    .limit(1)

  if (error) {
    logger.error('verify-catch-all: could not look for pending work', { error: error.message })
    return null
  }

  return (data?.[0]?.organisation_id as string | undefined) ?? null
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

  try {
    // A MISSING KEY IS A FAILURE, NOT A QUIET NO-OP. Without this the sweep would select
    // work, lock it, and fail on every single probe, burning the attempt counter until every
    // address hit its retry cap and became permanently unprocessable. Failing before the
    // lock leaves the backlog untouched.
    if (!process.env.BOUNCER_API_KEY) {
      const detail = 'BOUNCER_API_KEY is not set, so no second-pass verification can run.'
      logger.error('verify-catch-all: missing API key', { error: detail })
      await writeHeartbeat(supabase, false, detail)
      Sentry.captureCheckIn({ checkInId, monitorSlug: MONITOR_SLUG, status: 'error' }, MONITOR_CONFIG)
      await Sentry.flush(2000)
      return NextResponse.json({ ok: false, error: detail }, { status: 500 })
    }

    const organisationId = await findOrganisationWithSecondPassBacklog(supabase)

    // Nothing to do is the NORMAL state. It is where the platform sits whenever every
    // unconfirmable address has already had its second look.
    if (!organisationId) {
      logger.info('verify-catch-all: no organisation has a second-pass backlog')
      await writeHeartbeat(supabase, true, 'Nothing pending: every unconfirmable address has had a second pass.')
      Sentry.captureCheckIn({ checkInId, monitorSlug: MONITOR_SLUG, status: 'ok' }, MONITOR_CONFIG)
      await Sentry.flush(2000)
      return NextResponse.json({ ok: true, organisation_id: null, verified: 0, detail: 'nothing pending' })
    }

    const run = await runSecondPassBatch(supabase, organisationId, DEFAULT_SECOND_PASS_BATCH_SIZE)

    // 'failed' is the only status that is genuinely a problem. 'budget_exhausted' and
    // 'partial' are the system doing exactly what it is told, and paging on them would train
    // the alarm to be ignored on the day it matters.
    const ok = run.status !== 'failed'

    logger.info('verify-catch-all: run complete', {
      organisation_id: organisationId,
      status: run.status,
      total_verified: run.total_verified,
      recovered: run.recovered_count,
      still_unusable: run.still_unusable_count,
      failed: run.failed_count,
      calls_spent: run.calls_spent,
      daily_used: run.daily_calls_used,
    })

    await writeHeartbeat(
      supabase,
      ok,
      `${run.status}: verified ${run.total_verified}, recovered ${run.recovered_count}, ` +
      `still unusable ${run.still_unusable_count}, failed ${run.failed_count}, ` +
      `paid calls ${run.calls_spent}, daily used ${run.daily_calls_used ?? '?'}.` +
      (run.error_message ? ` ${run.error_message}` : ''),
    )

    Sentry.captureCheckIn(
      { checkInId, monitorSlug: MONITOR_SLUG, status: ok ? 'ok' : 'error' },
      MONITOR_CONFIG,
    )
    await Sentry.flush(2000)

    return NextResponse.json({
      ok,
      organisation_id: organisationId,
      status: run.status,
      verified: run.total_verified,
      recovered: run.recovered_count,
      still_unusable: run.still_unusable_count,
      failed: run.failed_count,
      calls_spent: run.calls_spent,
      daily_used: run.daily_calls_used,
      error: run.error_message,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('verify-catch-all: unexpected failure', { error: message })
    await writeHeartbeat(supabase, false, `Unexpected failure: ${message}`)
    Sentry.captureCheckIn({ checkInId, monitorSlug: MONITOR_SLUG, status: 'error' }, MONITOR_CONFIG)
    await Sentry.flush(2000)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
